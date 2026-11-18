#!/bin/bash
# Run at the end of the image build (P1-T5/T6/T7). It writes /usr/share/omacode/licenses/ and fails the build when a
# licence text is missing:
#
#   third-party.json       the manifest of what the image ships or downloads (container/third-party.json);
#   debian-packages.tsv    every Debian package with its version, its source package and the snapshot.debian.org link
#                          where the corresponding source of exactly that version stays available;
#   gpl-sources.txt        the source packages under a GPL or LGPL, for the release's source archive (CI, P1-T7).
set -euo pipefail
shopt -s globstar nullglob

OUT=/usr/share/omacode/licenses
MANIFEST=/opt/omacode/container/third-party.json
mkdir -p "$OUT"
cp "$MANIFEST" "$OUT/third-party.json"

missing=0

# Every installed Debian package keeps its copyright file; the slim image's dpkg filter must not have dropped one.
{
  printf 'package\tversion\tsource\tsource_version\tcopyright\tsnapshot\n'
  dpkg-query -W -f '${Package}\t${Version}\t${source:Package}\t${source:Version}\n' | while IFS=$'\t' read -r pkg ver src srcver; do
    copyright="/usr/share/doc/${pkg%%:*}/copyright"
    if [[ ! -e "$copyright" ]]; then
      echo "licenses: $pkg has no $copyright" >&2
      echo MISSING >>"$OUT/.missing"
    fi
    printf '%s\t%s\t%s\t%s\t%s\thttps://snapshot.debian.org/package/%s/%s/\n' "$pkg" "$ver" "$src" "$srcver" "$copyright" "$src" "$srcver"
  done
} >"$OUT/debian-packages.tsv"
if [[ -e "$OUT/.missing" ]]; then
  missing=$((missing + $(wc -l <"$OUT/.missing")))
  rm -f "$OUT/.missing"
fi

# The source packages whose copyright names a GPL or LGPL: what the release has to offer as source. Older copyright
# files are prose rather than DEP-5 fields, so the licence's name counts as well as a "License:" line.
awk -F'\t' 'NR > 1 { print $3 "\t" $4 "\t" $5 }' "$OUT/debian-packages.tsv" | sort -u | while IFS=$'\t' read -r src srcver copyright; do
  if [[ -e "$copyright" ]] && grep -qiE '^License: .*\b(L?GPL|AGPL)|GNU (Lesser |Library |Affero )?General Public License' "$copyright"; then printf '%s=%s\n' "$src" "$srcver"; fi
done | sort -u >"$OUT/gpl-sources.txt"

# Every shipped component of the manifest has at least one licence text where the manifest says.
while IFS=$'\t' read -r name optional patterns; do
  found=0
  IFS=' ' read -r -a list <<<"$patterns"
  for pattern in "${list[@]}"; do
    matches=($pattern)
    ((${#matches[@]})) && found=1
  done
  if ((!found)); then
    if [[ "$optional" == "true" ]]; then
      echo "licenses: $name is not in this image (optional)" >&2
    else
      echo "licenses: no licence text for $name (looked for: $patterns)" >&2
      missing=$((missing + 1))
    fi
  fi
done < <(node -e '
  for (const c of require(process.argv[1]).components)
    if (c.shipped && c.files.length) console.log([c.name, c.optional ? "true" : "false", c.files.join(" ")].join("\t"))
' "$MANIFEST")

echo "licenses: $(($(wc -l <"$OUT/debian-packages.tsv") - 1)) Debian packages, $(wc -l <"$OUT/gpl-sources.txt") GPL/LGPL source packages"
if ((missing)); then
  echo "licenses: $missing licence texts missing" >&2
  exit 1
fi
