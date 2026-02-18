param(
    [string]$UserPoolId = "eu-central-1_3KldA2ntG",
    [string]$Region = "eu-central-1",
    [string]$Profile = "emotix-test",
    [switch]$Execute
)

$ErrorActionPreference = "Stop"

function Get-AllCognitoUsernames {
    param(
        [string]$PoolId,
        [string]$AwsRegion,
        [string]$AwsProfile
    )

    # AWS CLI auto-paginates here; query returns usernames as tab-separated text.
    $raw = aws cognito-idp list-users `
        --user-pool-id $PoolId `
        --region $AwsRegion `
        --profile $AwsProfile `
        --query "Users[].Username" `
        --output text

    if (-not $raw) {
        return @()
    }

    $parts = ($raw -split "\s+") | Where-Object { $_ -and $_.Trim().Length -gt 0 }
    return @($parts)
}

Write-Host "Target User Pool: $UserPoolId" -ForegroundColor Cyan
Write-Host "Region: $Region, Profile: $Profile" -ForegroundColor Cyan

$allUsers = Get-AllCognitoUsernames -PoolId $UserPoolId -AwsRegion $Region -AwsProfile $Profile
$count = $allUsers.Count

if ($count -eq 0) {
    Write-Host "No users found. Nothing to delete." -ForegroundColor Yellow
    exit 0
}

Write-Host "Found $count users." -ForegroundColor Yellow

if (-not $Execute) {
    Write-Host "Dry-run mode. No users were deleted." -ForegroundColor Green
    Write-Host "Run with -Execute to perform deletion:" -ForegroundColor Green
    Write-Host ".\scripts\clear-cognito-user-pool.ps1 -Execute" -ForegroundColor Green
    Write-Host ""
    Write-Host "Sample usernames:"
    $allUsers | Select-Object -First 10 | ForEach-Object { Write-Host " - $_" }
    exit 0
}

$deleted = 0
foreach ($username in $allUsers) {
    aws cognito-idp admin-delete-user `
        --user-pool-id $UserPoolId `
        --username $username `
        --region $Region `
        --profile $Profile | Out-Null
    $deleted++
    Write-Host "Deleted: $username ($deleted/$count)"
}

Write-Host "Done. Deleted $deleted users from $UserPoolId." -ForegroundColor Green
