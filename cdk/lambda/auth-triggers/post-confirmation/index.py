from datetime import UTC, datetime
import json
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
    provider_sub = first.get("userId") or first.get("providerUserId")
    if isinstance(provider_name, str) and isinstance(provider_sub, str):
        return provider_name, provider_sub
    return None, None


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
    if event.get("triggerSource") != "PostConfirmation_ConfirmSignUp":
        return event

    attrs = event.get("request", {}).get("userAttributes", {})
    account_id = _extract_account_id(event)
    email = attrs.get("email")
    identities_attr = attrs.get("identities")
    username = event.get("userName") or ""
    now = _now_iso()

    if not account_id:
        logger.warning("PostConfirmation skipped: missing sub")
        return event

    normalized_email = _normalize_email(email) if email else ""
    existing_account_id = _existing_account_id_by_email(normalized_email) if normalized_email else None
    canonical_account_id = existing_account_id or account_id
    pk = f"USER#{canonical_account_id}"

    if email:
        if existing_account_id and existing_account_id != account_id:
            dynamodb.update_item(
                TableName=USERS_TABLE_NAME,
                Key={"pk": {"S": f"USER#{existing_account_id}"}},
                UpdateExpression="SET updated_at = :updated_at, #source = :source",
                ExpressionAttributeNames={"#source": "source"},
                ExpressionAttributeValues={
                    ":updated_at": {"S": now},
                    ":source": {"S": "COGNITO_POST_CONFIRMATION_EXISTING_EMAIL"},
                },
            )
        else:
            try:
                dynamodb.put_item(
                    TableName=USERS_TABLE_NAME,
                    Item={
                        "pk": {"S": pk},
                        "account_id": {"S": canonical_account_id},
                        "normalized_email": {"S": normalized_email},
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

    provider_name, provider_sub = _provider_from_identities_attr(identities_attr)
    if provider_name and provider_sub:
        _put_method(canonical_account_id, provider_name, provider_sub, username, now)
    elif existing_account_id:
        logger.info(
            "PostConfirmation skipped provider sync for existing email account_id=%s username=%s",
            canonical_account_id,
            username,
        )
        return event
    else:
        # Native signup confirmation can come with non-email username formats
        # (UUID/opaque values). Missing identities in this trigger means native flow.
        _put_method(canonical_account_id, "COGNITO", canonical_account_id, username, now)

    dynamodb.put_item(
        TableName=AUTH_AUDIT_LOG_TABLE_NAME,
        Item={
            "pk": {"S": pk},
            "sk": {"S": f"EVENT#{now}"},
            "action": {"S": "POST_CONFIRMATION_SIGNUP"},
            "provider": {"S": "COGNITO"},
            "created_at": {"S": now},
            "details": {"S": "Signup confirmed and profile metadata seeded"},
        },
    )

    return event
