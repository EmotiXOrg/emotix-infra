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


def _native_username(users: list[dict], default_username: str) -> str:
    native = next((u for u in users if "_" not in (u.get("Username") or "")), None)
    if native and native.get("Username"):
        return str(native["Username"])
    return default_username


def _native_sub(users: list[dict], native_username: str) -> str | None:
    native = next((u for u in users if u.get("Username") == native_username), None)
    if not native:
        return None
    attrs = native.get("Attributes", [])
    sub = next((a.get("Value") for a in attrs if a.get("Name") == "sub"), None)
    return str(sub) if sub else None


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
        code_name = err.response.get("Error", {}).get("Code", "Unknown")
        if code_name not in {"NotAuthorizedException"}:
            # NotAuthorizedException can happen when already confirmed; continue.
            return _response(400, {"message": "Invalid verification code"})

    users = _list_users_for_email(normalized_email)
    username = _native_username(users, normalized_email)

    try:
        cognito.admin_set_user_password(
            UserPoolId=USER_POOL_ID,
            Username=username,
            Password=new_password,
            Permanent=True,
        )
    except ClientError as err:
        logger.error("admin_set_user_password failed", extra={"error": err.response})
        return _response(400, {"message": "Failed to set password"})

    users = _list_users_for_email(normalized_email)
    sub = _native_sub(users, username)
    if sub:
        now = _now_iso()
        pk = f"USER#{sub}"
        dynamodb.put_item(
            TableName=USER_AUTH_METHODS_TABLE_NAME,
            Item={
                "pk": {"S": pk},
                "sk": {"S": "METHOD#COGNITO"},
                "provider": {"S": "COGNITO"},
                "provider_sub": {"S": sub},
                "linked_at": {"S": now},
                "verified": {"BOOL": True},
            },
        )
        dynamodb.put_item(
            TableName=AUTH_AUDIT_LOG_TABLE_NAME,
            Item={
                "pk": {"S": pk},
                "sk": {"S": f"EVENT#{now}"},
                "action": {"S": "SET_PASSWORD_PUBLIC_FLOW"},
                "provider": {"S": "COGNITO"},
                "created_at": {"S": now},
                "details": {"S": "Password set from login/signup flow"},
            },
        )

    return _response(200, {"ok": True})
