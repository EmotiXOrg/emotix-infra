import json
import logging
import os

import boto3

logger = logging.getLogger()
logger.setLevel(os.getenv("LOG_LEVEL", "INFO"))

dynamodb = boto3.client("dynamodb")
USER_AUTH_METHODS_TABLE_NAME = os.environ["USER_AUTH_METHODS_TABLE_NAME"]


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


def handler(event, _context):
    claims = (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims", {})
    )
    sub = claims.get("sub")
    if not sub:
        return _response(401, {"message": "Unauthorized"})

    pk = f"USER#{sub}"
    result = dynamodb.query(
        TableName=USER_AUTH_METHODS_TABLE_NAME,
        KeyConditionExpression="pk = :pk",
        ExpressionAttributeValues={":pk": {"S": pk}},
    )

    methods = []
    for item in result.get("Items", []):
        provider = item.get("provider", {}).get("S", "")
        methods.append(
            {
                "method": _provider_to_method(provider),
                "provider": provider,
                "linkedAt": item.get("linked_at", {}).get("S"),
                "verified": item.get("verified", {}).get("BOOL", False),
            }
        )

    return _response(200, {"methods": methods})
