import json
import logging
import os

import boto3

logger = logging.getLogger()
logger.setLevel(os.getenv("LOG_LEVEL", "INFO"))

dynamodb = boto3.client("dynamodb")
cognito = boto3.client("cognito-idp")
USERS_TABLE_NAME = os.environ["USERS_TABLE_NAME"]
USER_AUTH_METHODS_TABLE_NAME = os.environ["USER_AUTH_METHODS_TABLE_NAME"]
USER_POOL_ID = os.getenv("USER_POOL_ID")


def _response(status: int, body: dict):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(body),
    }


def _provider_to_method(provider: str) -> str:
    mapping = {
        "COGNITO": "password",
        "Google": "google",
        "GOOGLE": "google",
        "Facebook": "facebook",
        "FACEBOOK": "facebook",
    }
    return mapping.get(provider, provider.lower())


def _extract_attr(user: dict, attr_name: str) -> str | None:
    attrs = user.get("Attributes", [])
    hit = next((a for a in attrs if a.get("Name") == attr_name), None)
    return hit.get("Value") if hit else None


def _is_external_provider_user(user: dict) -> bool:
    return str(user.get("UserStatus", "")) == "EXTERNAL_PROVIDER"


def _find_users_by_email(email: str) -> list[dict]:
    if not USER_POOL_ID or not email:
        return []
    try:
        resp = cognito.list_users(
            UserPoolId=USER_POOL_ID,
            Filter=f'email = "{email}"',
            Limit=10,
        )
        return resp.get("Users", [])
    except Exception:
        logger.exception("Failed to read Cognito users by email")
        return []


def _find_users_by_sub(sub: str) -> list[dict]:
    if not USER_POOL_ID or not sub:
        return []
    try:
        resp = cognito.list_users(
            UserPoolId=USER_POOL_ID,
            Filter=f'sub = "{sub}"',
            Limit=5,
        )
        return resp.get("Users", [])
    except Exception:
        logger.exception("Failed to read Cognito users by sub")
        return []


def _existing_account_id_by_email(normalized_email: str | None) -> str | None:
    if not normalized_email:
        return None
    try:
        response = dynamodb.query(
            TableName=USERS_TABLE_NAME,
            IndexName="normalized_email-index",
            KeyConditionExpression="normalized_email = :email",
            ExpressionAttributeValues={":email": {"S": normalized_email}},
            Limit=1,
        )
    except Exception:
        logger.exception("Failed to resolve account id by normalized email")
        return None

    items = response.get("Items", [])
    if not items:
        return None
    pk = items[0].get("pk", {}).get("S", "")
    if isinstance(pk, str) and pk.startswith("USER#"):
        return pk.replace("USER#", "", 1)
    return None


def _resolve_canonical_sub(token_sub: str, email: str | None) -> str:
    # Access tokens from social flows may omit email. In that case, resolve email from
    # the Cognito user row for this token sub, then pick native account sub by email.
    # This keeps metadata reads stable for both native and social sessions.
    resolved_email = email.strip().lower() if email else None
    if not resolved_email:
        token_users = _find_users_by_sub(token_sub)
        if token_users:
            resolved_email = _extract_attr(token_users[0], "email")
            if isinstance(resolved_email, str):
                resolved_email = resolved_email.strip().lower()

    if not resolved_email:
        return token_sub

    existing_account_id = _existing_account_id_by_email(resolved_email)
    if existing_account_id:
        return existing_account_id

    users = _find_users_by_email(resolved_email)
    if not users:
        return token_sub

    native_user = next((u for u in users if not _is_external_provider_user(u)), None)
    if native_user:
        native_sub = _extract_attr(native_user, "sub")
        if native_sub:
            return native_sub
    return token_sub


def handler(event, _context):
    claims = (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims", {})
    )
    sub = claims.get("sub")
    email = claims.get("email")
    if not sub:
        return _response(401, {"message": "Unauthorized"})

    # Always query methods by canonical account key, not raw token sub, otherwise
    # social and native sessions can see different method lists for the same person.
    canonical_sub = _resolve_canonical_sub(sub, email if isinstance(email, str) else None)

    pk = f"USER#{canonical_sub}"
    result = dynamodb.query(
        TableName=USER_AUTH_METHODS_TABLE_NAME,
        KeyConditionExpression="pk = :pk",
        ExpressionAttributeValues={":pk": {"S": pk}},
    )

    methods_by_name: dict[str, dict] = {}
    for item in result.get("Items", []):
        provider = item.get("provider", {}).get("S", "")
        method = _provider_to_method(provider)
        linked_at = item.get("linked_at", {}).get("S")
        methods_by_name[method] = {
            "method": method,
            "provider": provider,
            "linkedAt": linked_at,
            "verified": item.get("verified", {}).get("BOOL", False),
        }

    methods = list(methods_by_name.values())

    return _response(200, {"methods": methods})
