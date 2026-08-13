#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly CONTROLLER_VERSION="3"
readonly VERSION_ARGUMENT="--apply-version=${CONTROLLER_VERSION}"
readonly CONTROLLER_TEMPLATE="${SCRIPT_DIR}/controller/frontmind-deploy-controller"
readonly FORCED_TEMPLATE="${SCRIPT_DIR}/controller/frontmind-deploy-forced-command"
readonly INCIDENT_TEMPLATE="${SCRIPT_DIR}/controller/frontmind-knowledge-base-incident-repair"
readonly CONTROLLER_TARGET="/usr/local/sbin/frontmind-deploy-controller"
readonly FORCED_TARGET="/usr/local/sbin/frontmind-deploy-forced-command"
readonly INCIDENT_TARGET="/usr/local/sbin/frontmind-knowledge-base-incident-repair"
readonly UPDATE_LOCK="/run/lock/frontmind-production-controller-update.lock"
readonly STACK_LOCK="/run/lock/frontmind-production-stack.lock"
readonly DASHBOARD_LOCK="/run/lock/frontmind-deploy-dashboard.lock"
readonly WEBSITE_LOCK="/run/lock/frontmind-deploy-website.lock"
readonly RECOVERY_ROOT="/var/lib/frontmind-deploy/controller-update"
readonly RECOVERY_MARKER="${RECOVERY_ROOT}/pending"
readonly CONTROLLER_BACKUP="${RECOVERY_ROOT}/frontmind-deploy-controller.previous"
readonly FORCED_BACKUP="${RECOVERY_ROOT}/frontmind-deploy-forced-command.previous"
readonly INCIDENT_BACKUP="${RECOVERY_ROOT}/frontmind-knowledge-base-incident-repair.previous"
readonly INCIDENT_ABSENT="${RECOVERY_ROOT}/frontmind-knowledge-base-incident-repair.absent"
update_committed=0

die() {
  printf '%s\n' "$1" >&2
  exit "${2:-1}"
}

root_owned_executable() {
  local target="$1"
  [[ -f $target && ! -L $target && $(stat -c '%u:%g:%a' "$target") == "0:0:755" ]]
}

validate_controller() {
  local target="$1"
  bash -n "$target" \
    && [[ $(grep -Fxc -- "# frontmind-production-controller-version: ${CONTROLLER_VERSION}" "$target" || true) == 1 ]] \
    && grep -Fq -- '--kb-manus-v2-rollout' "$target" \
    && grep -Fq -- 'dual-read|canary|migration|pause|complete' "$target" \
    && grep -Fq -- 'PRODUCTION_KB_MANUS_V2_ROLLOUT_RESTORED' "$target" \
    && grep -Fq -- 'FRONTMIND_KB_MANUS_V2_ACTIVE_MIGRATION' "$target" \
    && ! grep -Eq -- 'frontmind-dashboard-dev|dashboard-dev\.frontmind\.net|/etc/frontmind-dev|/var/lib/frontmind-dev' "$target"
}

validate_forced_command() {
  local target="$1"
  bash -n "$target" \
    && grep -Fq -- '/usr/local/sbin/frontmind-deploy-controller' "$target" \
    && grep -Fq -- 'dual-read|canary|migration|pause|complete' "$target" \
    && grep -Fq -- 'expected_service="${1:-}"' "$target"
}

validate_incident_wrapper() {
  local target="$1"
  bash -n "$target" \
    && grep -Fq -- 'KB_INCIDENT_REPAIR_REQUIRES_ROOT' "$target" \
    && grep -Fq -- '/run/lock/frontmind-production-stack.lock' "$target" \
    && grep -Fq -- '/run/lock/frontmind-deploy-dashboard.lock' "$target" \
    && grep -Fq -- '/app/dist/knowledge-base-incident-repair-cli.js' "$target" \
    && ! grep -Fq -- 'frontmind-deploy-forced-command' "$target"
}

root_owned_private_executable() {
  local target="$1"
  [[ -f $target && ! -L $target && $(stat -c '%u:%g:%a' "$target") == "0:0:700" ]]
}

install_atomically() {
  local source="$1" target="$2" temporary
  temporary="$(mktemp "${target}.tmp.XXXXXX")" || return 1
  if ! install -o root -g root -m 0755 "$source" "$temporary" \
    || ! mv -f -- "$temporary" "$target"; then
    rm -f -- "$temporary" || true
    return 1
  fi
  root_owned_executable "$target"
}

install_private_atomically() {
  local source="$1" target="$2" temporary
  temporary="$(mktemp "${target}.tmp.XXXXXX")" || return 1
  if ! install -o root -g root -m 0700 "$source" "$temporary" \
    || ! mv -f -- "$temporary" "$target"; then
    rm -f -- "$temporary" || true
    return 1
  fi
  root_owned_private_executable "$target"
}

recover_interrupted_update() {
  [[ -f $RECOVERY_MARKER && ! -L $RECOVERY_MARKER ]] || return 1
  [[ $(cat "$RECOVERY_MARKER") == "version=${CONTROLLER_VERSION}" ]] || return 1
  [[ -f $CONTROLLER_BACKUP && ! -L $CONTROLLER_BACKUP ]] || return 1
  [[ -f $FORCED_BACKUP && ! -L $FORCED_BACKUP ]] || return 1
  [[ ( -f $INCIDENT_BACKUP && ! -L $INCIDENT_BACKUP && ! -e $INCIDENT_ABSENT ) \
    || ( -f $INCIDENT_ABSENT && ! -L $INCIDENT_ABSENT && ! -e $INCIDENT_BACKUP ) ]] || return 1
  if ! install_atomically "$CONTROLLER_BACKUP" "$CONTROLLER_TARGET" \
    || ! install_atomically "$FORCED_BACKUP" "$FORCED_TARGET"; then
    return 1
  fi
  if [[ -f $INCIDENT_BACKUP ]]; then
    install_private_atomically "$INCIDENT_BACKUP" "$INCIDENT_TARGET" || return 1
  else
    rm -f -- "$INCIDENT_TARGET" || return 1
  fi
  rm -f -- "$RECOVERY_MARKER" "$CONTROLLER_BACKUP" "$FORCED_BACKUP" \
    "$INCIDENT_BACKUP" "$INCIDENT_ABSENT" || return 1
}

restore_controller_update() {
  if (( update_committed == 0 )) && [[ -f $RECOVERY_MARKER && ! -L $RECOVERY_MARKER ]]; then
    recover_interrupted_update \
      || printf '%s\n' "PRODUCTION_CONTROLLER_UPDATE_RECOVERY_PENDING" >&2
  fi
}

[[ $EUID -eq 0 ]] || die "PRODUCTION_CONTROLLER_UPDATE_REQUIRES_ROOT" 77
[[ $# -eq 1 && $1 == "$VERSION_ARGUMENT" ]] \
  || die "usage: sudo ./update-release-controllers.sh ${VERSION_ARGUMENT}" 64
for command in bash cat flock grep install mkdir mktemp mv rm stat; do
  command -v "$command" >/dev/null 2>&1 \
    || die "PRODUCTION_CONTROLLER_UPDATE_COMMAND_MISSING:${command}" 69
done
validate_controller "$CONTROLLER_TEMPLATE" \
  || die "PRODUCTION_CONTROLLER_TEMPLATE_REJECTED" 78
validate_forced_command "$FORCED_TEMPLATE" \
  || die "PRODUCTION_FORCED_COMMAND_TEMPLATE_REJECTED" 78
validate_incident_wrapper "$INCIDENT_TEMPLATE" \
  || die "PRODUCTION_INCIDENT_WRAPPER_TEMPLATE_REJECTED" 78

exec 8>"$UPDATE_LOCK"
flock -n 8 || die "PRODUCTION_CONTROLLER_UPDATE_ALREADY_RUNNING" 75
exec 7>"$STACK_LOCK"
flock -n 7 || die "PRODUCTION_STACK_RELEASE_ACTIVE" 75
exec 9>"$DASHBOARD_LOCK"
flock -n 9 || die "PRODUCTION_DASHBOARD_RELEASE_ACTIVE" 75
exec 10>"$WEBSITE_LOCK"
flock -n 10 || die "PRODUCTION_WEBSITE_RELEASE_ACTIVE" 75

mkdir -p -m 0700 "$RECOVERY_ROOT"
[[ -d $RECOVERY_ROOT && ! -L $RECOVERY_ROOT \
  && $(stat -c '%u:%g:%a' "$RECOVERY_ROOT") == "0:0:700" ]] \
  || die "PRODUCTION_CONTROLLER_UPDATE_RECOVERY_ROOT_REJECTED" 73
if [[ -e $RECOVERY_MARKER || -L $RECOVERY_MARKER ]]; then
  recover_interrupted_update \
    || die "PRODUCTION_CONTROLLER_UPDATE_RECOVERY_FAILED" 73
  printf '%s\n' "PRODUCTION_CONTROLLER_UPDATE_RECOVERED_PREVIOUS"
fi
root_owned_executable "$CONTROLLER_TARGET" \
  || die "PRODUCTION_CONTROLLER_TARGET_INVALID" 73
root_owned_executable "$FORCED_TARGET" \
  || die "PRODUCTION_FORCED_COMMAND_TARGET_INVALID" 73
if [[ -e $INCIDENT_TARGET || -L $INCIDENT_TARGET ]]; then
  root_owned_private_executable "$INCIDENT_TARGET" \
    || die "PRODUCTION_INCIDENT_WRAPPER_TARGET_INVALID" 73
  install -o root -g root -m 0600 "$INCIDENT_TARGET" "$INCIDENT_BACKUP" \
    || die "PRODUCTION_INCIDENT_WRAPPER_BACKUP_FAILED" 70
else
  : >"$INCIDENT_ABSENT" || die "PRODUCTION_INCIDENT_WRAPPER_BACKUP_FAILED" 70
  chmod 0600 "$INCIDENT_ABSENT"
fi
install -o root -g root -m 0600 "$CONTROLLER_TARGET" "$CONTROLLER_BACKUP" \
  || {
    rm -f -- "$INCIDENT_BACKUP" "$INCIDENT_ABSENT" || true
    die "PRODUCTION_CONTROLLER_BACKUP_FAILED" 70
  }
install -o root -g root -m 0600 "$FORCED_TARGET" "$FORCED_BACKUP" \
  || {
    rm -f -- "$CONTROLLER_BACKUP" "$FORCED_BACKUP" "$INCIDENT_BACKUP" "$INCIDENT_ABSENT" || true
    die "PRODUCTION_FORCED_COMMAND_BACKUP_FAILED" 70
  }
marker_temporary="$(mktemp "${RECOVERY_MARKER}.tmp.XXXXXX")" \
  || {
    rm -f -- "$CONTROLLER_BACKUP" "$FORCED_BACKUP" "$INCIDENT_BACKUP" "$INCIDENT_ABSENT" || true
    die "PRODUCTION_CONTROLLER_UPDATE_MARKER_FAILED" 70
  }
if ! printf '%s\n' "version=${CONTROLLER_VERSION}" >"$marker_temporary" \
  || ! chmod 0600 "$marker_temporary" \
  || ! mv -f -- "$marker_temporary" "$RECOVERY_MARKER"; then
  rm -f -- "$marker_temporary" "$CONTROLLER_BACKUP" "$FORCED_BACKUP" \
    "$INCIDENT_BACKUP" "$INCIDENT_ABSENT" || true
  die "PRODUCTION_CONTROLLER_UPDATE_MARKER_FAILED" 70
fi

trap restore_controller_update EXIT
trap 'restore_controller_update; trap - TERM; exit 143' TERM
trap 'restore_controller_update; trap - INT; exit 130' INT

if ! install_atomically "$CONTROLLER_TEMPLATE" "$CONTROLLER_TARGET" \
  || ! install_atomically "$FORCED_TEMPLATE" "$FORCED_TARGET" \
  || ! install_private_atomically "$INCIDENT_TEMPLATE" "$INCIDENT_TARGET" \
  || ! validate_controller "$CONTROLLER_TARGET" \
  || ! validate_forced_command "$FORCED_TARGET" \
  || ! validate_incident_wrapper "$INCIDENT_TARGET"; then
  recover_interrupted_update || true
  die "PRODUCTION_CONTROLLER_UPDATE_ROLLED_BACK" 70
fi
rm -f -- "$RECOVERY_MARKER" \
  || die "PRODUCTION_CONTROLLER_UPDATE_COMMIT_FAILED" 70
update_committed=1
rm -f -- "$CONTROLLER_BACKUP" "$FORCED_BACKUP" "$INCIDENT_BACKUP" "$INCIDENT_ABSENT" \
  || printf '%s\n' "PRODUCTION_CONTROLLER_UPDATE_STALE_BACKUP_WARNING" >&2

printf '%s\n' "PRODUCTION_CONTROLLER_UPDATE_OK version=${CONTROLLER_VERSION}"
