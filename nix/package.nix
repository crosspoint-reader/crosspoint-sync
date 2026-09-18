{ pkgs, lib }:

with pkgs;
buildNpmPackage {
  pname = "crosspoint-sync";
  version = "git";
  src = ../.;

  npmDeps = importNpmLock {
    npmRoot = ../.;
  };

  npmConfigHook = importNpmLock.npmConfigHook;

  buildPhase = ''
    npm run build
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib $out/bin
    cp -r package.json dist node_modules assets migrations $out/lib/
    makeWrapper ${lib.getExe nodejs} $out/bin/crosspoint-sync \
      --add-flags "$out/lib/dist/index.js"
    runHook postInstall
  '';

  nativeBuildInputs = [ pkgs.makeWrapper ];

  meta = {
    description = "Lightweight KoSync Server for Syncing Crosspoint/CrossInk stats & progress";
    homepage = "https://github.com/crosspoint-reader/crosspoint-sync";
    mainProgram = "crosspoint-sync";
  };
}
