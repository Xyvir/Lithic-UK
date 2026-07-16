param(
    [Parameter(Mandatory=$true)]
    [string[]]$Files
)

foreach ($f in $Files) {
    if (Test-Path $f) {
        $t = [IO.File]::ReadAllText($f)
        [IO.File]::WriteAllText($f, $t.TrimEnd())
    }
}
