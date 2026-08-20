{
  description = "crosspoint-sync flake";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      ...
    }:
    {
      nixosModules = {
        crosspoint-sync = import ./nix/module.nix;
      };
    }
    // flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        crosspoint-sync = pkgs.callPackage ./nix/package.nix { };
      in
      {
        packages = {
          inherit crosspoint-sync;
          default = crosspoint-sync;
        };
      }
    );
}
