{ pkgs, lib }:

with pkgs;
buildNpmPackage {
  pname = "crosspoint-sync";
  version = "git";
  # node:sqlite needs Node 22.5+, and ffmpeg splits audiobooks for hosted
  # transcription, so both must be in the runtime closure.
  nodejs = nodejs_24;
  buildInputs = [ ffmpeg ];
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
      --prefix PATH : ${lib.makeBinPath [ ffmpeg ]} \
      --add-flags "$out/lib/dist/index.js"
    runHook postInstall
  '';

  nativeBuildInputs = [ pkgs.makeWrapper ];

  meta = {
    description = "Reading progress sync, stats and highlights for any KOSync-compatible e-reader";
    homepage = "https://github.com/crosspoint-reader/crosspoint-sync";
    mainProgram = "crosspoint-sync";
  };
}
