#!/usr/bin/env bash
# Tag every released version of the add-on.
#
# A release is a commit that changed `version:` in klimo/config.yaml — that
# field is what Home Assistant's Supervisor uses to offer an update. This
# script tags the first commit that introduced each version, annotating it with
# that version's section of the changelog. Existing tags are left alone, so it
# is safe to re-run after each release.
#
#   bash scripts/tag-releases.sh          # create the missing tags
#   bash scripts/tag-releases.sh --push   # ...and push them to origin
#
set -euo pipefail

cd "$(dirname "$0")/.."
CONFIG=klimo/config.yaml
CHANGELOG=klimo/CHANGELOG.md
push=false
[ "${1:-}" = "--push" ] && push=true

# The changelog section for a version: everything from "## <version>" up to the
# next "## " heading.
changelog_section() {
  [ -f "$CHANGELOG" ] || return 0
  awk -v want="## $1" '
    $0 == want { grab = 1; next }
    grab && /^## / { exit }
    grab { print }
  ' "$CHANGELOG"
}

created=0
seen=""
# Oldest first, so the first sighting of a version is the commit that shipped it. A version
# only counts once its changelog section exists as well: 0.1.0 sat in config.yaml from the very
# first commit, and its release is the commit that wrote "## 0.1.0", not the empty scaffold.
for sha in $(git log --reverse --format=%H -- "$CONFIG" "$CHANGELOG"); do
  version=$(git show "$sha:$CONFIG" 2>/dev/null | sed -n 's/^version:[[:space:]]*"\{0,1\}\([0-9.]*\)"\{0,1\}.*/\1/p')
  [ -n "$version" ] || continue
  case " $seen " in *" $version "*) continue ;; esac
  git show "$sha:$CHANGELOG" 2>/dev/null | grep -qxF "## $version" || continue
  seen="$seen $version"

  tag="v$version"
  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then continue; fi

  { printf 'Klimo %s\n\n' "$version"; changelog_section "$version"; } |
    git tag -a "$tag" "$sha" -F -
  echo "tagged $tag -> $(git rev-parse --short "$sha")"
  created=$((created + 1))
done

echo "$created tag(s) created"
if [ "$push" = true ] && [ "$created" -gt 0 ]; then
  git push origin --tags
fi
