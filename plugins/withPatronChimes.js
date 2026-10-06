// Bundles Patron's two notification chimes (see scripts/audio/generate_chimes.py).
//
// Why a local plugin instead of expo-notifications' `sounds` option: that option
// copies EVERY listed file into BOTH platforms. The chimes ship in two formats
// (.caf for iOS, .ogg for Android) with the same base name, and two files named
// patron_chime.* in Android's res/raw is a "Duplicate resources" build error.
// So: iOS gets only assets/sounds/ios/*.caf, Android gets only
// assets/sounds/android/*.ogg. (The legacy patron_default/patron_urgent .wav
// stay on expo-notifications' list so channels already created on installed
// devices keep a valid sound.)
const fs = require('fs');
const path = require('path');
const { withDangerousMod, withXcodeProject, IOSConfig } = require('expo/config-plugins');

const SOUND_DIR = ['assets', 'sounds'];
const list = (root, platform, ext) => {
  const dir = path.join(root, ...SOUND_DIR, platform);
  if (!fs.existsSync(dir)) {
    throw new Error(`withPatronChimes: ${dir} is missing — run scripts/audio/generate_chimes.py`);
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith(ext)).sort();
  if (files.length === 0) throw new Error(`withPatronChimes: no ${ext} files in ${dir}`);
  return files.map(f => ({ name: f, from: path.join(dir, f) }));
};

const withAndroidChimes = config =>
  withDangerousMod(config, ['android', async cfg => {
    const root = cfg.modRequest.projectRoot;
    const raw = path.join(root, 'android', 'app', 'src', 'main', 'res', 'raw');
    fs.mkdirSync(raw, { recursive: true });
    for (const f of list(root, 'android', '.ogg')) fs.copyFileSync(f.from, path.join(raw, f.name));
    return cfg;
  }]);

const withIosChimes = config =>
  withXcodeProject(config, cfg => {
    const root = cfg.modRequest.projectRoot;
    const projectName = cfg.modRequest.projectName;
    const sourceRoot = IOSConfig.Paths.getSourceRoot(root);
    const project = cfg.modResults;
    for (const f of list(root, 'ios', '.caf')) {
      fs.copyFileSync(f.from, path.join(sourceRoot, f.name));
      if (!project.hasFile(`${projectName}/${f.name}`)) {
        IOSConfig.XcodeUtils.addResourceFileToGroup({
          filepath: `${projectName}/${f.name}`,
          groupName: projectName,
          isBuildFile: true,
          project,
        });
      }
    }
    return cfg;
  });

module.exports = config => withIosChimes(withAndroidChimes(config));
