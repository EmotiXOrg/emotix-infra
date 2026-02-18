from datetime import UTC, datetime
import json
import logging
import os

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(os.getenv("LOG_LEVEL", "INFO"))

cognito = boto3.client("cognito-idp")
dynamodb = boto3.client("dynamodb")

USERS_TABLE_NAME = os.environ["USERS_TABLE_NAME"]
USER_AUTH_METHODS_TABLE_NAME = os.environ["USER_AUTH_METHODS_TABLE_NAME"]
AUTH_AUDIT_LOG_TABLE_NAME = os.environ["AUTH_AUDIT_LOG_TABLE_NAME"]


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _normalize_email(email: str) -> str:
    return email.strip().lower()


def _provider_from_identities_attr(raw_identities: str | None) -> tuple[str | None, str | None]:
    if not raw_identities:
        return None, None
    try:
        identities = json.loads(raw_identities)
    except Exception:
        return None, None
    if not isinstance(identities, list) or not identities:
        return None, None
    first = identities[0]
    if not isinstance(first, dict):
        return None, None

    provider_name = first.get("providerName")
    # Different providers payloads may use userId / providerUserId; keep both.
    provider_sub = first.get("userId") or first.get("providerUserId")
    if isinstance(provider_name, str) and isinstance(provider_sub, str):
        return provider_name, provider_sub
    return None, None


def _is_external_provider_user(user: dict) -> bool:
    return str(user.get("UserStatus", "")) == "EXTERNAL_PROVIDER"


def _extract_attr(user: dict, attr_name: str) -> str | None:
    attrs = user.get("Attributes", [])
    hit = next((a for a in attrs if a.get("Name") == attr_name), None)
    return hit.get("Value") if hit else None


def _find_users_by_email(user_pool_id: str, email: str) -> list[dict]:
    if not email:
        return []
    resp = cognito.list_users(
        UserPoolId=user_pool_id,
        Filter=f'email = "{email}"',
        Limit=10,
    )
    return resp.get("Users", [])


def _find_users_by_sub(user_pool_id: str, sub: str) -> list[dict]:
    if not sub:
        return []
    resp = cognito.list_users(
        UserPoolId=user_pool_id,
        Filter=f'sub = "{sub}"',
        Limit=5,
    )
    return resp.get("Users", [])


def _existing_account_id_by_email(normalized_email: str | None) -> str | None:
    if not normalized_email:
        return None
    response = dynamodb.query(
        TableName=USERS_TABLE_NAME,
        IndexName="normalized_email-index",
        KeyConditionExpression="normalized_email = :email",
        ExpressionAttributeValues={":email": {"S": normalized_email}},
        Limit=1,
    )
    items = response.get("Items", [])
    if not items:
        return None
    pk = items[0].get("pk", {}).get("S", "")
    if isinstance(pk, str) and pk.startswith("USER#"):
        return pk.replace("USER#", "", 1)
    return None


def _put_method(account_id: str, provider: str, provider_sub: str, username: str, now: str) -> None:
    try:
        dynamodb.put_item(
            TableName=USER_AUTH_METHODS_TABLE_NAME,
            Item={
                "pk": {"S": f"USER#{account_id}"},
                "sk": {"S": f"METHOD#{provider.upper()}"},
                "provider": {"S": provider},
                "provider_sub": {"S": provider_sub},
                "linked_at": {"S": now},
                "verified": {"BOOL": True},
                "username": {"S": username},
            },
            ConditionExpression="attribute_not_exists(pk) AND attribute_not_exists(sk)",
        )
    except ClientError as err:
        code = err.response.get("Error", {}).get("Code", "Unknown")
        if code != "ConditionalCheckFailedException":
            raise
        logger.info("Auth method already attached account_id=%s provider=%s", account_id, provider)


def _put_audit(account_id: str, action: str, provider: str, details: str, now: str) -> None:
    dynamodb.put_item(
        TableName=AUTH_AUDIT_LOG_TABLE_NAME,
        Item={
            "pk": {"S": f"USER#{account_id}"},
            "sk": {"S": f"EVENT#{now}"},
            "action": {"S": action},
            "provider": {"S": provider},
            "created_at": {"S": now},
            "details": {"S": details},
        },
    )


def handler(event, _context):
    if event.get("triggerSource") != "PostAuthentication_Authentication":
        return event

    user_pool_id = event.get("userPoolId")
    if not user_pool_id:
        return event

    attrs = event.get("request", {}).get("userAttributes", {})
    username = event.get("userName") or ""
    account_id = attrs.get("sub")
    email = attrs.get("email")
    identities_attr = attrs.get("identities")
    now = _now_iso()

    if not account_id:
        return event

    provider_name, provider_sub = None, None
    # Default to current sub, then switch to native sub for same email when available.
    # This ensures method metadata is stored under one account key.
    canonical_account_id = account_id
    native_user = None

    normalized_email = _normalize_email(email) if email else None
    existing_account_id = _existing_account_id_by_email(normalized_email)
    if existing_account_id:
        canonical_account_id = existing_account_id

    users = _find_users_by_email(user_pool_id, normalized_email) if normalized_email else []
    if users:
        native_user = next((u for u in users if not _is_external_provider_user(u)), None)
        if native_user and not existing_account_id:
            native_sub = _extract_attr(native_user, "sub")
            if native_sub:
                canonical_account_id = native_sub

    current_users = _find_users_by_sub(user_pool_id, account_id)
    current_user = current_users[0] if current_users else None
    current_is_external = _is_external_provider_user(current_user) if current_user else False
    if current_is_external:
        provider_name, provider_sub = _provider_from_identities_attr(identities_attr)
        if not (provider_name and provider_sub) and current_user:
            persisted_identities = _extract_attr(current_user, "identities")
            backfill_provider_name, backfill_provider_sub = _provider_from_identities_attr(persisted_identities)
            provider_name = provider_name or backfill_provider_name
            provider_sub = provider_sub or backfill_provider_sub

    if current_is_external and not (provider_name and provider_sub):
        logger.error(
            "POST_AUTH_PROVIDER_CONTEXT_MISSING sub=%s username=%s identities_present=%s",
            account_id,
            username,
            bool(identities_attr),
        )
        _put_audit(
            canonical_account_id,
            "POST_AUTH_PROVIDER_CONTEXT_MISSING",
            "UNKNOWN",
            "External-provider login had no resolvable identities payload",
            now,
        )
        return event

    if current_is_external and provider_name and provider_sub:
        _put_method(canonical_account_id, provider_name, provider_sub, username, now)

    if not (current_is_external and provider_name and provider_sub and normalized_email and native_user):
        return event

    destination_username = native_user.get("Username")
    if not destination_username:
        return event

    try:
        cognito.admin_link_provider_for_user(
            UserPoolId=user_pool_id,
            DestinationUser={
                "ProviderName": "Cognito",
                "ProviderAttributeValue": destination_username,
            },
            SourceUser={
                "ProviderName": provider_name,
                "ProviderAttributeName": "Cognito_Subject",
                "ProviderAttributeValue": provider_sub,
            },
        )
        _put_audit(
            canonical_account_id,
            "AUTO_LINK_POST_AUTH",
            provider_name,
            f"Linked {provider_name} to native user {destination_username}",
            now,
        )
    except ClientError as err:
        code = err.response.get("Error", {}).get("Code", "Unknown")
        if code in {"InvalidParameterException", "ResourceConflictException"}:
            return event
        logger.exception("Post-auth auto-link failed for provider=%s email=%s", provider_name, normalized_email)

    return event
