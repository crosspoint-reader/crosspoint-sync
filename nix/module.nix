{
  pkgs,
  lib,
  config,
  ...
}:

let

  inherit (lib)
    mkOption
    mkEnableOption
    mkIf
    types
    ;
  cfg = config.services.crosspoint-sync;
  crosspoint-sync = pkgs.callPackage ./package.nix { };

  filename =
    types.addCheck types.str (v: v != "" && !(lib.hasInfix "/" v) && v != "." && v != "..")
    // {
      description = "a filename; cannot traverse directories or be an absolute path";
    };
in
{

  options.services.crosspoint-sync = {
    enable = mkEnableOption "Enable crosspoint-sync server";

    port = mkOption {
      type = types.port;
      description = "Port to run crosspoint-sync server on";
      default = 8080;
    };

    databaseFile = mkOption {
      type = filename;
      description = "Filename of the SQLite database in the state directory; ";
      default = "crosspoint.db";
    };

    registration = mkOption {
      type = types.bool;
      description = "Have registration enabled or not";
      default = true;
    };

    tokenEncryptionKeyFile = mkOption {
      type = types.nullOr types.str;
      description = "Path to the secret that contains the encryption key";
    };

    authRateLimit = mkOption {
      type = types.int;
      description = "Per-IP limit on registrations";
      default = 30;
    };

    user = mkOption {
      type = types.str;
      description = "User to run crosspoint-sync with";
      default = "crosspoint-sync";
    };

    group = mkOption {
      type = types.str;
      description = "Group to run crosspoint-sync with";
      default = "crosspoint-sync";
    };

  };

  config = mkIf cfg.enable {
    systemd.services.crosspoint-sync = {
      description = "crosspoint-sync server";
      wantedBy = [ "multi-user.target" ];

      serviceConfig = {
        Type = "simple";
        ExecStart =
          if (cfg.tokenEncryptionKeyFile != null) then
            pkgs.writeShellScript "crosspoint-sync-credential-loader" ''
              export TOKEN_ENC_KEY="$(cat "$CREDENTIALS_DIRECTORY/TOKEN_ENC_KEY_FILE")"
              exec ${lib.getExe crosspoint-sync}
            ''
          else
            "${lib.getExe crosspoint-sync}";
        Restart = "on-failure";

        User = cfg.user;
        Group = cfg.group;
        LoadCredential = mkIf (
          cfg.tokenEncryptionKeyFile != null
        ) "TOKEN_ENC_KEY_FILE:${cfg.tokenEncryptionKeyFile}";
        StateDirectory = "crosspoint-sync";
        ProtectSystem = "strict";
        ProtectHome = true;
        NoNewPrivileges = true;
        PrivateDevices = true;
        PrivateTmp = true;
        PrivateUsers = !(cfg.port < 1024);
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        ProtectProc = "invisible";
        ProcSubset = "pid";
        RestrictNamespaces = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        UMask = "0077";
        RemoveIPC = true;
        AmbientCapabilities = if (cfg.port < 1024) then "CAP_NET_BIND_SERVICE" else lib.mkForce "";
        CapabilityBoundingSet = if (cfg.port < 1024) then "CAP_NET_BIND_SERVICE" else lib.mkForce "";
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
        ];
        SystemCallFilter = [ "@system-service" ];
        SystemCallErrorNumber = "EPERM";
        RestrictRealtime = true;

      };

      environment = {
        PORT = builtins.toString cfg.port;
        DATABASE_PATH = "/var/lib/crosspoint-sync/${cfg.databaseFile}";
        REGISTRATION_DISABLED = if !cfg.registration then "true" else "false";
        AUTH_RATE_LIMIT_PER_MINUTE = builtins.toString cfg.authRateLimit;
      };

    };

    networking.firewall.allowedTCPPorts = [ cfg.port ];

    users = {
      users.crosspoint-sync = mkIf (cfg.user == "crosspoint-sync") {
        description = "crosspoint-sync service user";
        isSystemUser = true;
        group = cfg.group;
      };

      groups.crosspoint-sync = mkIf (cfg.group == "crosspoint-sync") { };
    };

  };

}
