# ---------------------------------------------------------------------------
# Generates treatments/*.html from treatment.template.html + treatments.json
#
# Run from anywhere:   powershell -File _build\build-treatments.ps1
#
# This file is intentionally pure ASCII. All Hebrew copy lives in
# treatments.json and treatment.template.html, both read as UTF-8, so
# PowerShell 5.1 never has to parse non-ASCII source.
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$tplPath  = Join-Path $PSScriptRoot 'treatment.template.html'
$dataPath = Join-Path $PSScriptRoot 'treatments.json'
$outDir   = Join-Path $root 'treatments'

if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

$utf8 = New-Object System.Text.UTF8Encoding($false)
$tpl  = [System.IO.File]::ReadAllText($tplPath, $utf8)
$json = [System.IO.File]::ReadAllText($dataPath, $utf8) | ConvertFrom-Json

$n = 0
foreach ($p in $json) {

    $body = ($p.body -join "`n          ")

    $faq = ''
    $i = 0
    foreach ($f in $p.faq) {
        $id = 'f-' + $p.slug + '-' + $i
        $faq += '<div class="acc__item">' + "`n"
        $faq += '              <button class="acc__btn" type="button" aria-expanded="false" aria-controls="' + $id + '">' + "`n"
        $faq += '                <span>' + $f.q + '</span><span class="acc__ico" aria-hidden="true"></span>' + "`n"
        $faq += '              </button>' + "`n"
        $faq += '              <div class="acc__panel" id="' + $id + '" data-open="false"><div><p>' + $f.a + '</p></div></div>' + "`n"
        $faq += '            </div>' + "`n            "
        $i++
    }

    $html = $tpl
    $map = [ordered]@{
        '{{TITLE}}'      = $p.title
        '{{DESC}}'       = $p.desc
        '{{CRUMB}}'      = $p.crumb
        '{{EYEBROW}}'    = $p.eyebrow
        '{{H1}}'         = $p.h1
        '{{LEAD}}'       = $p.lead
        '{{DURATION}}'   = $p.duration
        '{{ANESTHESIA}}' = $p.anesthesia
        '{{RECOVERY}}'   = $p.recovery
        '{{ONSET}}'      = $p.onset
        '{{LASTS}}'      = $p.lasts
        '{{BODY}}'       = $body
        '{{FAQ}}'        = $faq.TrimEnd()
    }
    foreach ($k in $map.Keys) { $html = $html.Replace($k, [string]$map[$k]) }

    $target = Join-Path $outDir ($p.slug + '.html')
    [System.IO.File]::WriteAllText($target, $html, $utf8)
    Write-Output ("wrote {0}  ({1} bytes)" -f (Split-Path -Leaf $target), $html.Length)
    $n++
}

Write-Output ("done: {0} treatment pages" -f $n)
