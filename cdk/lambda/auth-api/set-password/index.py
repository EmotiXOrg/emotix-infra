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
USER_AUTH_METHODS_TABLE_NAME = os.environ["USER_AUTH_METHODS_TABLE_NAME"]
AUTH_AUDIT_LOG_TABLE_NAME = os.environ["AUTH_AUDIT_LOG_TABLE_NAME"]
MAX_AUTH_AGE_SECONDS = 900


def _response(status: int, body: dict):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(body),
    }


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _is_recent_auth(auth_time_raw: str | None) -> bool:
    if not auth_time_raw:
        return False
    try:
        auth_time = int(auth_time_raw)
    except ValueError:
        return False
    now_epoch = int(datetime.now(UTC).timestamp())
    return now_epoch - auth_time <= MAX_AUTH_AGE_SECONDS


def handler(event, _context):
    claims = (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims", {})
    )
    sub = claims.get("sub")
    username = claims.get("cognito:username") or sub
    auth_time = claims.get("auth_time")
    if not sub or not username:
        return _response(401, {"message": "Unauthorized"})

    if not _is_recent_auth(auth_time):
        return _response(401, {"message": "Recent authentication required"})

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _response(400, {"message": "Invalid JSON body"})

    new_password = body.get("newPassword")
    if not isinstance(new_password, str) or len(new_password) < 10:
        return _response(400, {"message": "newPassword is required and must be at least 10 chars"})

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
            "action": {"S": "SET_PASSWORD"},
            "provider": {"S": "COGNITO"},
            "created_at": {"S": now},
            "details": {"S": "Password enabled for account"},
        },
    )

    return _response(200, {"ok": True})
