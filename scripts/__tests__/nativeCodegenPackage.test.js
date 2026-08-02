const {readFileSync} = require('fs');
const {join} = require('path');

const repositoryRoot = join(__dirname, '..', '..');
const packageJson = require('../../package.json');
const moduleSource = readFileSync(
  join(
    repositoryRoot,
    'android/app/src/main/java/com/fpvarbcon/transport/UsbSerialTransportModule.kt',
  ),
  'utf8',
);
const packageSource = readFileSync(
  join(
    repositoryRoot,
    'android/app/src/main/java/com/fpvarbcon/transport/UsbSerialTransportPackage.kt',
  ),
  'utf8',
);

describe('Android TurboModule codegen package contract', () => {
  it('resolves the generated spec from the Gradle-configured app package', () => {
    const javaPackageName = packageJson.codegenConfig.android.javaPackageName;

    expect(javaPackageName).toBe('com.fpvarbcon.transport');
    expect(moduleSource).toMatch(/^package com\.fpvarbcon\.transport$/m);
    expect(packageSource).toMatch(/^package com\.fpvarbcon\.transport$/m);
    expect(moduleSource).toContain('NativeUsbSerialTransportSpec(reactContext)');
    expect(packageSource).toContain('NativeUsbSerialTransportSpec.NAME');
  });

  it('does not import the CLI default package that Gradle does not generate', () => {
    const wrongImport =
      'import com.facebook.fbreact.specs.NativeUsbSerialTransportSpec';

    expect(moduleSource).not.toContain(wrongImport);
    expect(packageSource).not.toContain(wrongImport);
  });
});
