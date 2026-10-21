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
