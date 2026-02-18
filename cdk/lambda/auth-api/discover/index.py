import json
import logging
import os
from collections.abc import Iterable

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
    if prefix == "signinwithapple":
        return "apple"
    # Username may contain "_" for native users (for example, email local-part).
    return "password"


def _extract_providers_from_identities(raw_identities) -> set[str]:
    if not raw_identities:
        return set()
    try:
        identities = json.loads(raw_identities) if isinstance(raw_identities, str) else raw_identities
    except Exception:
        return set()

    methods: set[str] = set()
    if not isinstance(identities, Iterable):
        return methods
    for identity in identities:
        if not isinstance(identity, dict):
            continue
        provider_name = str(identity.get("providerName", "")).strip()
        if provider_name:
            methods.add(_provider_to_method(provider_name))
    return methods


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


def _is_external_provider_user(user: dict) -> bool:
    return str(user.get("UserStatus", "")) == "EXTERNAL_PROVIDER"


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

    native_user = next((u for u in users if not _is_external_provider_user(u)), None)
    chosen_user = native_user or users[0]
    username = chosen_user.get("Username", "")
    account_id = _extract_attr(chosen_user, "sub")
    native_email_verified = (
        str(_extract_attr(native_user, "email_verified") or "").lower() == "true"
        if native_user
        else False
    )
    native_confirmed = str(native_user.get("UserStatus", "")).upper() == "CONFIRMED" if native_user else False

    methods: list[str] = []
    if account_id:
        items = _get_method_rows(account_id)
        methods = [
            _provider_to_method(item.get("provider", {}).get("S", item.get("sk", {}).get("S", "").replace("METHOD#", "")))
            for item in items
        ]

    inferred_methods: set[str] = set()
    for user in users:
        if _is_external_provider_user(user):
            inferred_methods.add(_infer_provider_from_username(user.get("Username", "")))
        else:
            inferred_methods.add("password")
        inferred_methods |= _extract_providers_from_identities(_extract_attr(user, "identities"))

    if not methods and inferred_methods:
        methods = list(inferred_methods)
    elif inferred_methods:
        methods = methods + list(inferred_methods)
    elif not methods:
        methods = [_infer_provider_from_username(username)]

    unique_methods = list(dict.fromkeys(methods))
    has_password = "password" in unique_methods
    password_login_ready = has_password and native_confirmed and native_email_verified

    if has_password and not password_login_ready:
        next_action = "needs_verification"
    elif unique_methods == ["password"]:
        next_action = "password"
    elif has_password:
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
