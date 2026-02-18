param(
    [string]$Region = "eu-central-1",
    [string]$Profile = "emotix-test",
    [string]$StackName = "EmotixTestAuthStack",
    [string]$UsersTableName = "",
    [string]$UserAuthMethodsTableName = "",
    [string]$AuthAuditLogTableName = "",
    [switch]$Execute
)

$ErrorActionPreference = "Stop"

function Write-Utf8NoBomFile {
    param(
        [string]$Path,
        [string]$Content
    )

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Resolve-TableNamesFromStack {
    param(
        [string]$Name,
        [string]$AwsRegion,
        [string]$AwsProfile
    )

    $raw = aws cloudformation describe-stacks `
        --stack-name $Name `
        --region $AwsRegion `
        --profile $AwsProfile `
        --output json
    $obj = $raw | ConvertFrom-Json
    $outputs = $obj.Stacks[0].Outputs

    $result = @{
        UsersTableName = ""
        UserAuthMethodsTableName = ""
        AuthAuditLogTableName = ""
    }

    foreach ($o in $outputs) {
        switch ($o.OutputKey) {
            "UsersTableName" { $result.UsersTableName = [string]$o.OutputValue }
            "UserAuthMethodsTableName" { $result.UserAuthMethodsTableName = [string]$o.OutputValue }
            "AuthAuditLogTableName" { $result.AuthAuditLogTableName = [string]$o.OutputValue }
        }
    }
    return $result
}

function Get-TableKeySchema {
    param(
        [string]$TableName,
        [string]$AwsRegion,
        [string]$AwsProfile
    )

    $raw = aws dynamodb describe-table `
        --table-name $TableName `
        --region $AwsRegion `
        --profile $AwsProfile `
        --output json
    $obj = $raw | ConvertFrom-Json
    $schema = $obj.Table.KeySchema
    return @($schema | ForEach-Object { [string]$_.AttributeName })
}

function Get-AllItems {
    param(
        [string]$TableName,
        [string]$AwsRegion,
        [string]$AwsProfile
    )

    $items = @()
    $lastKey = $null

    while ($true) {
        $args = @(
            "dynamodb", "scan",
            "--table-name", $TableName,
            "--region", $AwsRegion,
            "--profile", $AwsProfile,
            "--output", "json"
        )

        if ($lastKey) {
            $lekJson = $lastKey | ConvertTo-Json -Depth 10 -Compress
            $args += @("--exclusive-start-key", $lekJson)
        }

        $raw = aws @args
        $page = $raw | ConvertFrom-Json

        if ($page.Items) {
            $items += @($page.Items)
        }

        if (-not $page.LastEvaluatedKey) {
            break
        }
        $lastKey = $page.LastEvaluatedKey
    }

    return $items
}

function Get-KeyFromItem {
    param(
        [object]$Item,
        [string[]]$KeyNames
    )

    $key = @{}
    foreach ($k in $KeyNames) {
        if (-not $Item.PSObject.Properties.Name.Contains($k)) {
            throw "Item missing key attribute '$k'."
        }
        $key[$k] = $Item.$k
    }
    return $key
}

function Invoke-BatchDelete {
    param(
        [string]$TableName,
        [object[]]$Items,
        [string[]]$KeyNames,
        [string]$AwsRegion,
        [string]$AwsProfile
    )

    $total = $Items.Count
    if ($total -eq 0) {
        Write-Host "Table '$TableName': no items to delete." -ForegroundColor Yellow
        return
    }

    $index = 0
    while ($index -lt $total) {
        $end = [Math]::Min($index + 24, $total - 1)
        $chunk = $Items[$index..$end]

        $deleteRequests = @()
        foreach ($item in $chunk) {
            $deleteRequests += @{
                DeleteRequest = @{
                    Key = Get-KeyFromItem -Item $item -KeyNames $KeyNames
                }
            }
        }

        $requestItems = @{
            $TableName = $deleteRequests
        }
        $payload = $requestItems | ConvertTo-Json -Depth 30 -Compress
        $tmpFile = Join-Path $env:TEMP ("ddb-batch-delete-" + [Guid]::NewGuid().ToString() + ".json")
        Write-Utf8NoBomFile -Path $tmpFile -Content $payload

        try {
            $raw = aws dynamodb batch-write-item `
                --request-items ("file://" + $tmpFile) `
                --region $AwsRegion `
                --profile $AwsProfile `
                --output json
            if ($LASTEXITCODE -ne 0) {
                throw "AWS CLI batch-write-item failed for table '$TableName'."
            }
            $res = $raw | ConvertFrom-Json

            while ($res.UnprocessedItems -and $res.UnprocessedItems.PSObject.Properties.Count -gt 0) {
                Start-Sleep -Milliseconds 300
                $retryPayload = $res.UnprocessedItems | ConvertTo-Json -Depth 30 -Compress
                Write-Utf8NoBomFile -Path $tmpFile -Content $retryPayload
                $retryRaw = aws dynamodb batch-write-item `
                    --request-items ("file://" + $tmpFile) `
                    --region $AwsRegion `
                    --profile $AwsProfile `
                    --output json
                if ($LASTEXITCODE -ne 0) {
                    throw "AWS CLI batch-write-item retry failed for table '$TableName'."
                }
                $res = $retryRaw | ConvertFrom-Json
            }
        }
        finally {
            Remove-Item -Path $tmpFile -ErrorAction SilentlyContinue
        }

        $index = $end + 1
        Write-Host "Table '$TableName': deleted $index / $total"
    }
}

if (-not $UsersTableName -or -not $UserAuthMethodsTableName -or -not $AuthAuditLogTableName) {
    Write-Host "Resolving table names from CloudFormation stack '$StackName'..." -ForegroundColor Cyan
    $resolved = Resolve-TableNamesFromStack -Name $StackName -AwsRegion $Region -AwsProfile $Profile
    if (-not $UsersTableName) { $UsersTableName = $resolved.UsersTableName }
    if (-not $UserAuthMethodsTableName) { $UserAuthMethodsTableName = $resolved.UserAuthMethodsTableName }
    if (-not $AuthAuditLogTableName) { $AuthAuditLogTableName = $resolved.AuthAuditLogTableName }
}

if (-not $UsersTableName -or -not $UserAuthMethodsTableName -or -not $AuthAuditLogTableName) {
    throw "Could not resolve all table names. Provide them explicitly via params."
}

$tables = @($UsersTableName, $UserAuthMethodsTableName, $AuthAuditLogTableName)

Write-Host "Region: $Region, Profile: $Profile" -ForegroundColor Cyan
Write-Host "Target tables:" -ForegroundColor Cyan
$tables | ForEach-Object { Write-Host " - $_" }

$scanSummary = @{}
foreach ($t in $tables) {
    $items = Get-AllItems -TableName $t -AwsRegion $Region -AwsProfile $Profile
    $scanSummary[$t] = $items
    Write-Host "Table '$t': found $($items.Count) items."
}

if (-not $Execute) {
    Write-Host "Dry-run mode. No data deleted." -ForegroundColor Green
    Write-Host "Run with -Execute to delete all items from listed tables." -ForegroundColor Green
    exit 0
}

foreach ($t in $tables) {
    $keyNames = Get-TableKeySchema -TableName $t -AwsRegion $Region -AwsProfile $Profile
    Invoke-BatchDelete -TableName $t -Items $scanSummary[$t] -KeyNames $keyNames -AwsRegion $Region -AwsProfile $Profile
}

Write-Host "Done. All requested tables were cleared." -ForegroundColor Green
