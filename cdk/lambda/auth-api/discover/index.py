import json
import logging
import os

import boto3

logger = logging.getLogger()
logger.setLevel(os.getenv("LOG_LEVEL", "INFO"))

cognito = boto3.client("cognito-idp")
dynamodb = boto3.client("dynamodb")

USER_POOL_ID = os.environ["USER_POOL_ID"]
USER_AUTH_METHODS_TABLE_NAME = os.environ["USER_AUTH_METHODS_TABLE_NAME"]


def _response(status: int, body: dict):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(body),
    }


def _normalize_email(email: str) -> str:
    return email.strip().lower()


def _provider_to_method(provider: str) -> str:
    mapping = {
        "COGNITO": "password",
        "Google": "google",
        "GOOGLE": "google",
        "Facebook": "facebook",
        "FACEBOOK": "facebook",
    }
    return mapping.get(provider, provider.lower())


def _infer_provider_from_username(username: str) -> str:
    if "_" not in username:
        return "password"
    prefix = username.split("_", 1)[0].lower()
    if prefix == "google":
        return "google"
    if prefix == "facebook":
        return "facebook"
    return prefix


def _get_method_rows(account_id: str) -> list[dict]:
    pk = f"USER#{account_id}"
    result = dynamodb.query(
        TableName=USER_AUTH_METHODS_TABLE_NAME,
        KeyConditionExpression="pk = :pk",
        ExpressionAttributeValues={":pk": {"S": pk}},
    )
    return result.get("Items", [])


def _extract_attr(user: dict, attr_name: str) -> str | None:
    attrs = user.get("Attributes", [])
    hit = next((a for a in attrs if a.get("Name") == attr_name), None)
    return hit.get("Value") if hit else None


def handler(event, _context):
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _response(400, {"message": "Invalid JSON body"})

    email = body.get("email")
    if not isinstance(email, str) or not email.strip():
        return _response(400, {"message": "Email is required"})
    normalized_email = _normalize_email(email)

    users_resp = cognito.list_users(
        UserPoolId=USER_POOL_ID,
        Filter=f'email = "{normalized_email}"',
        Limit=10,
    )
    users = users_resp.get("Users", [])

    # Relaxed anti-enumeration: always return 200, but response may include methods if found.
    if not users:
        return _response(
            200,
            {
                "email": normalized_email,
                "methods": ["password", "google", "facebook"],
                "nextAction": "signup_or_signin",
            },
        )

    native_user = next((u for u in users if "_" not in (u.get("Username") or "")), None)
    chosen_user = native_user or users[0]
    username = chosen_user.get("Username", "")
    account_id = _extract_attr(chosen_user, "sub")
    email_verified = str(_extract_attr(chosen_user, "email_verified") or "").lower() == "true"

    methods: list[str] = []
    if account_id:
        items = _get_method_rows(account_id)
        methods = [
            _provider_to_method(item.get("provider", {}).get("S", item.get("sk", {}).get("S", "").replace("METHOD#", "")))
            for item in items
        ]

    if not methods:
        methods = [_infer_provider_from_username(username)]

    unique_methods = list(dict.fromkeys(methods))

    if not email_verified:
        next_action = "needs_verification"
    elif unique_methods == ["password"]:
        next_action = "password"
    elif "password" in unique_methods:
        next_action = "choose_method"
    else:
        next_action = "social"

    return _response(
        200,
        {
            "email": normalized_email,
            "methods": unique_methods,
            "nextAction": next_action,
        },
    )
