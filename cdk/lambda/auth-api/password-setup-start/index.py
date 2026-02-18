import json
import logging
import os
import secrets
import string

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(os.getenv("LOG_LEVEL", "INFO"))

cognito = boto3.client("cognito-idp")
USER_POOL_CLIENT_ID = os.environ["USER_POOL_CLIENT_ID"]


def _response(status: int, body: dict):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(body),
    }


def _normalize_email(email: str) -> str:
    return email.strip().lower()


def _random_password() -> str:
    alphabet = string.ascii_letters + string.digits
    core = "".join(secrets.choice(alphabet) for _ in range(20))
    return f"Aa{core}9"


def handler(event, _context):
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return _response(400, {"message": "Invalid JSON body"})

    email = body.get("email")
    if not isinstance(email, str) or not email.strip():
        return _response(400, {"message": "Email is required"})
    normalized_email = _normalize_email(email)

    try:
        cognito.sign_up(
            ClientId=USER_POOL_CLIENT_ID,
            Username=normalized_email,
            Password=_random_password(),
            UserAttributes=[{"Name": "email", "Value": normalized_email}],
        )
    except ClientError as err:
        code = err.response.get("Error", {}).get("Code", "Unknown")
        if code != "UsernameExistsException":
            logger.error("sign_up failed", extra={"error": err.response})
            return _response(400, {"message": "Unable to start email verification"})

    try:
        cognito.resend_confirmation_code(
            ClientId=USER_POOL_CLIENT_ID,
            Username=normalized_email,
        )
    except ClientError:
        # avoid enumeration leakage; keep success response
        pass

    return _response(200, {"ok": True})
