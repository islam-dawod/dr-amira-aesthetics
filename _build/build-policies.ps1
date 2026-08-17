# ---------------------------------------------------------------------------
# Generates privacy.html / ai-privacy.html / accessibility.html / terms.html
# from policy.template.html + policies.json
#
# Run:  powershell -File _build\build-policies.ps1
#
# Pure ASCII on purpose - all Hebrew copy lives in the UTF-8 data files.
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'

$root     = Split-Path -Parent $PSScriptRoot
$tplPath  = Join-Path $PSScriptRoot 'policy.template.html'
$dataPath = Join-Path $PSScriptRoot 'policies.json'

$utf8 = New-Object System.Text.UTF8Encoding($false)
$tpl  = [System.IO.File]::ReadAllText($tplPath, $utf8)
$json = [System.IO.File]::ReadAllText($dataPath, $utf8) | ConvertFrom-Json

$n = 0
foreach ($p in $json) {

    $body = ($p.body -join "`n          ")

    $toc = ''
    foreach ($t in $p.toc) {
        $toc += '<li><a href="#' + $t.id + '">' + $t.label + '</a></li>' + "`n              "
    }

    $html = $tpl
    $map = [ordered]@{
        '{{TITLE}}'   = $p.title
        '{{DESC}}'    = $p.desc
        '{{CRUMB}}'   = $p.crumb
        '{{EYEBROW}}' = $p.eyebrow
        '{{H1}}'      = $p.h1
        '{{LEAD}}'    = $p.lead
        '{{UPDATED}}' = $p.updated
        '{{BODY}}'    = $body
        '{{TOC}}'     = $toc.TrimEnd()
    }
    foreach ($k in $map.Keys) { $html = $html.Replace($k, [string]$map[$k]) }

    $target = Join-Path $root ($p.slug + '.html')
    [System.IO.File]::WriteAllText($target, $html, $utf8)
    Write-Output ("wrote {0}  ({1} bytes)" -f (Split-Path -Leaf $target), $html.Length)
    $n++
}

Write-Output ("done: {0} policy pages" -f $n)
