from datetime import UTC, datetime
import logging
import os

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(os.getenv("LOG_LEVEL", "INFO"))

dynamodb = boto3.client("dynamodb")
USERS_TABLE_NAME = os.environ["USERS_TABLE_NAME"]
USER_AUTH_METHODS_TABLE_NAME = os.environ["USER_AUTH_METHODS_TABLE_NAME"]
AUTH_AUDIT_LOG_TABLE_NAME = os.environ["AUTH_AUDIT_LOG_TABLE_NAME"]


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _normalize_email(email: str) -> str:
    return email.strip().lower()


def _extract_account_id(event: dict) -> str | None:
    attrs = event.get("request", {}).get("userAttributes", {})
    return attrs.get("sub")


def handler(event, _context):
    if event.get("triggerSource") not in {"PostConfirmation_ConfirmSignUp", "PostConfirmation_ConfirmForgotPassword"}:
        return event

    attrs = event.get("request", {}).get("userAttributes", {})
    account_id = _extract_account_id(event)
    email = attrs.get("email")
    username = event.get("userName") or ""
    now = _now_iso()

    if not account_id:
        logger.warning("PostConfirmation skipped: missing sub")
        return event

    pk = f"USER#{account_id}"

    if email:
        try:
            dynamodb.put_item(
                TableName=USERS_TABLE_NAME,
                Item={
                    "pk": {"S": pk},
                    "account_id": {"S": account_id},
                    "normalized_email": {"S": _normalize_email(email)},
                    "status": {"S": "ACTIVE"},
                    "created_at": {"S": now},
                    "updated_at": {"S": now},
                    "source": {"S": "COGNITO_POST_CONFIRMATION"},
                },
                ConditionExpression="attribute_not_exists(pk)",
            )
        except ClientError as err:
            code = err.response.get("Error", {}).get("Code")
            if code != "ConditionalCheckFailedException":
                raise

    # Seed native login method metadata for user settings and audits.
    dynamodb.put_item(
        TableName=USER_AUTH_METHODS_TABLE_NAME,
        Item={
            "pk": {"S": pk},
            "sk": {"S": "METHOD#COGNITO"},
            "provider": {"S": "COGNITO"},
            "provider_sub": {"S": account_id},
            "linked_at": {"S": now},
            "verified": {"BOOL": True},
            "username": {"S": username},
        },
    )

    dynamodb.put_item(
        TableName=AUTH_AUDIT_LOG_TABLE_NAME,
        Item={
            "pk": {"S": pk},
            "sk": {"S": f"EVENT#{now}"},
            "action": {"S": "POST_CONFIRMATION"},
            "provider": {"S": "COGNITO"},
            "created_at": {"S": now},
            "details": {"S": "Native account confirmed"},
        },
    )

    return event
