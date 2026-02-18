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

USER_POOL_ID = os.environ["USER_POOL_ID"]
USER_POOL_CLIENT_ID = os.environ["USER_POOL_CLIENT_ID"]
USERS_TABLE_NAME = os.environ["USERS_TABLE_NAME"]
USER_AUTH_METHODS_TABLE_NAME = os.environ["USER_AUTH_METHODS_TABLE_NAME"]
AUTH_AUDIT_LOG_TABLE_NAME = os.environ["AUTH_AUDIT_LOG_TABLE_NAME"]


def _response(status: int, body: dict):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(body),
    }


def _normalize_email(email: str) -> str:
    return email.strip().lower()


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _list_users_for_email(normalized_email: str) -> list[dict]:
    resp = cognito.list_users(
        UserPoolId=USER_POOL_ID,
        Filter=f'email = "{normalized_email}"',
        Limit=10,
    )
    return resp.get("Users", [])


def _extract_attr(user: dict, attr_name: str) -> str | None:
    attrs = user.get("Attributes", [])
    hit = next((a for a in attrs if a.get("Name") == attr_name), None)
    return hit.get("Value") if hit else None


def _is_external_provider_user(user: dict) -> bool:
    return str(user.get("UserStatus", "")) == "EXTERNAL_PROVIDER"


def _resolve_native_user(users: list[dict], normalized_email: str) -> dict | None:
    native_by_username = next(
        (u for u in users if not _is_external_provider_user(u) and str(u.get("Username", "")).lower() == normalized_email),
        None,
    )
    if native_by_username:
        return native_by_username
    return next((u for u in users if not _is_external_provider_user(u)), None)


def _provider_context_from_external_user(user: dict) -> tuple[str | None, str | None]:
    raw_identities = _extract_attr(user, "identities")
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
    provider_sub = first.get("userId") or first.get("providerUserId")
    if isinstance(provider_name, str) and isinstance(provider_sub, str):
        return provider_name, provider_sub
    return None, None


def _put_audit(sub: str, action: str, provider: str, details: str, now: str) -> None:
    dynamodb.put_item(
        TableName=AUTH_AUDIT_LOG_TABLE_NAME,
        Item={
            "pk": {"S": f"USER#{sub}"},
            "sk": {"S": f"EVENT#{now}"},
            "action": {"S": action},
            "provider": {"S": provider},
            "created_at": {"S": now},
            "details": {"S": details},
        },
    )


def _existing_account_id_by_email(normalized_email: str) -> str | None:
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


def handler(event, _context):
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _response(400, {"message": "Invalid JSON body"})

    email = body.get("email")
    code = body.get("code")
    new_password = body.get("newPassword")
    if not isinstance(email, str) or not email.strip():
        return _response(400, {"message": "Email is required"})
    if not isinstance(code, str) or not code.strip():
        return _response(400, {"message": "Verification code is required"})
    if not isinstance(new_password, str) or len(new_password) < 10:
        return _response(400, {"message": "newPassword is required and must be at least 10 chars"})

    normalized_email = _normalize_email(email)

    try:
        cognito.confirm_sign_up(
            ClientId=USER_POOL_CLIENT_ID,
            Username=normalized_email,
            ConfirmationCode=code.strip(),
        )
    except ClientError as err:
        error_code = err.response.get("Error", {}).get("Code", "Unknown")
        if error_code not in {"NotAuthorizedException"}:
            # NotAuthorizedException can happen when already confirmed; continue.
            return _response(400, {"message": "Invalid verification code", "code": error_code})

    users = _list_users_for_email(normalized_email)
    native_user = _resolve_native_user(users, normalized_email)
    if not native_user:
        logger.error("PASSWORD_SETUP_NATIVE_USER_MISSING email=%s users_found=%s", normalized_email, len(users))
        return _response(
            400,
            {
                "message": "Account setup is incomplete. Please continue with your social login and try again.",
                "code": "NATIVE_USER_MISSING",
            },
        )

    username = str(native_user.get("Username", ""))
    native_sub = _extract_attr(native_user, "sub")
    if not native_sub:
        logger.error("PASSWORD_SETUP_NATIVE_SUB_MISSING email=%s username=%s", normalized_email, username)
        return _response(
            400,
            {
                "message": "Account setup is incomplete. Please continue with your social login and try again.",
                "code": "NATIVE_SUB_MISSING",
            },
        )

    now = _now_iso()

    try:
        cognito.admin_set_user_password(
            UserPoolId=USER_POOL_ID,
            Username=username,
            Password=new_password,
            Permanent=True,
        )
    except ClientError as err:
        logger.error("admin_set_user_password failed", extra={"error": err.response})
        error_code = err.response.get("Error", {}).get("Code", "Unknown")
        return _response(400, {"message": "Failed to set password", "code": error_code})

    external_users = [u for u in users if _is_external_provider_user(u)]
    for external_user in external_users:
        provider_name, provider_sub = _provider_context_from_external_user(external_user)
        if not provider_name or not provider_sub:
            logger.error(
                "PASSWORD_SETUP_PROVIDER_CONTEXT_MISSING email=%s username=%s",
                normalized_email,
                str(external_user.get("Username", "")),
            )
            _put_audit(
                native_sub,
                "PASSWORD_SETUP_PROVIDER_CONTEXT_MISSING",
                "UNKNOWN",
                "External user exists but has no provider context in identities",
                now,
            )
            continue

        try:
            cognito.admin_link_provider_for_user(
                UserPoolId=USER_POOL_ID,
                DestinationUser={
                    "ProviderName": "Cognito",
                    "ProviderAttributeValue": username,
                },
                SourceUser={
                    "ProviderName": provider_name,
                    "ProviderAttributeName": "Cognito_Subject",
                    "ProviderAttributeValue": provider_sub,
                },
            )
            _put_audit(
                native_sub,
                "PASSWORD_SETUP_LINK_PROVIDER",
                provider_name,
                f"Linked provider {provider_name} to {username} during password setup completion",
                now,
            )
        except ClientError as err:
            error_code = err.response.get("Error", {}).get("Code", "Unknown")
            if error_code == "InvalidParameterException":
                # Already linked to the same destination account.
                continue
            if error_code in {"AliasExistsException", "ResourceConflictException"}:
                _put_audit(
                    native_sub,
                    "PASSWORD_SETUP_LINK_PROVIDER_CONFLICT",
                    provider_name,
                    "Provider is linked to another account",
                    now,
                )
                return _response(
                    409,
                    {
                        "message": "This social login is already linked to another account. Use your original sign-in method.",
                        "code": "PROVIDER_LINK_CONFLICT",
                    },
                )
            logger.exception("admin_link_provider_for_user failed provider=%s email=%s", provider_name, normalized_email)
            return _response(
                500,
                {
                    "message": "Failed to link your social sign-in. Please try again.",
                    "code": "PROVIDER_LINK_FAILED",
                },
            )

    canonical_account_id = _existing_account_id_by_email(normalized_email) or native_sub
    pk = f"USER#{canonical_account_id}"
    dynamodb.put_item(
        TableName=USER_AUTH_METHODS_TABLE_NAME,
        Item={
            "pk": {"S": pk},
            "sk": {"S": "METHOD#COGNITO"},
            "provider": {"S": "COGNITO"},
            "provider_sub": {"S": canonical_account_id},
            "linked_at": {"S": now},
            "verified": {"BOOL": True},
            "username": {"S": username},
        },
    )
    _put_audit(
        canonical_account_id,
        "SET_PASSWORD_PUBLIC_FLOW",
        "COGNITO",
        "Password set from login/signup flow",
        now,
    )

    return _response(200, {"ok": True})
