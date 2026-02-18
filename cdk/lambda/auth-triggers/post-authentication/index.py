from datetime import UTC, datetime
import logging
import os

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(os.getenv("LOG_LEVEL", "INFO"))

cognito = boto3.client("cognito-idp")
dynamodb = boto3.client("dynamodb")

USER_AUTH_METHODS_TABLE_NAME = os.environ["USER_AUTH_METHODS_TABLE_NAME"]
AUTH_AUDIT_LOG_TABLE_NAME = os.environ["AUTH_AUDIT_LOG_TABLE_NAME"]


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _normalize_email(email: str) -> str:
    return email.strip().lower()


def _provider_name_from_username(username: str) -> str | None:
    if "_" not in username:
        return None
    raw = username.split("_", 1)[0].lower()
    mapping = {
        "google": "Google",
        "facebook": "Facebook",
        "signinwithapple": "SignInWithApple",
    }
    return mapping.get(raw)


def _provider_subject_from_username(username: str) -> str | None:
    if "_" not in username:
        return None
    return username.split("_", 1)[1]


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


def _put_method(account_id: str, provider: str, provider_sub: str, username: str, now: str) -> None:
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
    )


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
    now = _now_iso()

    if not account_id:
        return event

    provider_name = _provider_name_from_username(username)
    provider_sub = _provider_subject_from_username(username)
    # Default to current sub, then switch to native sub for same email when available.
    # This ensures method metadata is stored under one account key.
    canonical_account_id = account_id
    native_user = None

    normalized_email = _normalize_email(email) if email else None
    users = _find_users_by_email(user_pool_id, normalized_email) if normalized_email else []
    if users:
        native_user = next((u for u in users if not _is_external_provider_user(u)), None)
        if native_user:
            native_sub = _extract_attr(native_user, "sub")
            if native_sub:
                canonical_account_id = native_sub

    # Always ensure current login method is represented in metadata table.
    if provider_name and provider_sub:
        _put_method(canonical_account_id, provider_name, provider_sub, username, now)
    else:
        _put_method(canonical_account_id, "COGNITO", canonical_account_id, username, now)

    if not (provider_name and provider_sub and normalized_email and native_user):
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
