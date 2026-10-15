"""Read-only Dockerfile/workflow regression checks. Run inside approved /ws worker."""
from pathlib import Path
import unittest

class ImageContract(unittest.TestCase):
    def test_economic_pinned_native_artifacts(self):
        text = Path('Dockerfile.transcription').read_text()
        self.assertIn('ghcr.io/kkolyno/wormhole_discord_bot@sha256:b281ad7f705f13fb2998c8cb5ee536a1a4beac2f26c894e8a7baff3d9adf650a AS validated-native', text)
        self.assertIn('node:22.22.0-alpine3.23@sha256:e4bf2a82ad0a4037d28035ae71529873c069b13eb0455466ae0bc13363826e34 AS runtime', text)
        self.assertIn('COPY --from=validated-native /usr/local/bin/whisper-cli', text)
        self.assertIn('a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002', text)
        self.assertIn('147964211', text)
        self.assertIn('env -i PATH=', text)
        self.assertNotIn('curl ', text)

    def test_private_nonroot_tini_actual_flock_and_safe_entrypoint(self):
        text = Path('Dockerfile.transcription').read_text()
        for required in ['util-linux', '/usr/bin/flock --version | grep util-linux', 'chmod 700 /data/transcription',
                         'chown -R 1001:1001 /data', 'USER nodejs', '--ignore-scripts', '>=35s',
                         'ENTRYPOINT ["/sbin/tini", "--", "docker-entrypoint.sh"]', 'CMD ["node", "index.js"]']:
            self.assertIn(required, text)
        for forbidden in ['COPY . ', 'COPY tools/ ', 'LOCAL_TRANSCRIPTION_ENABLED=true', 'LOCAL_TRANSCRIPT_ATTACHMENTS=true']:
            self.assertNotIn(forbidden, text)

    def test_explicit_branch_only_mutually_exclusive_native_arm_dispatch(self):
        text = Path('.github/workflows/docker-publish.yml').read_text()
        for required in ['local_transcription:', 'oracle_test:', 'mutually exclusive', 'default: false',
                         '"$EVENT_NAME" != workflow_dispatch', '"$REF_TYPE" != branch', '"$REF" == refs/heads/main',
                         '^[0-9a-f]{40}$', "'ubuntu-24.04-arm'", 'platforms: linux/arm64', 'cancel-in-progress: false']:
            self.assertIn(required, text)
        self.assertIn('file: Dockerfile.transcription', text)
        self.assertIn("inputs.oracle_test && 'Dockerfile.oracle-test' || 'Dockerfile'", text)
        self.assertIn('tags: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:transcription-${{ github.sha }}', text)
        self.assertEqual(text.count('if: ${{ !inputs.local_transcription }}'), 2)
        local_step = text.split('- name: Build and load local transcription image', 1)[1]
        self.assertNotIn('steps.meta', local_step)
        self.assertNotIn('latest', local_step)
        self.assertIn('Transcription commit tag already exists', text)
        self.assertIn('Cannot establish that the transcription commit tag is absent', text)
        self.assertIn('value=latest,enable=${{ github.ref == \'refs/heads/main\' && !inputs.oracle_test }}', text)
        self.assertIn('type=sha,prefix=,enable=${{ !inputs.oracle_test }}', text)

    def test_transcription_push_only_after_offline_native_test_of_loaded_image(self):
        text = Path('.github/workflows/docker-publish.yml').read_text()
        build_start = text.index('- name: Build and load local transcription image')
        test_start = text.index('- name: Offline native transcription preflight')
        public_start = text.index('- name: Public English recognizer smoke')
        push_start = text.index('- name: Push tested local transcription image')
        self.assertLess(build_start, test_start)
        self.assertLess(test_start, public_start)
        self.assertLess(public_start, push_start)
        build, preflight, public, push = text[build_start:test_start], text[test_start:public_start], text[public_start:push_start], text[push_start:]
        for required in ['push: false', 'load: true', 'platforms: linux/arm64']:
            self.assertIn(required, build)
        self.assertNotIn('push: true', build)
        for step in [build, preflight, push]:
            self.assertIn('if: ${{ inputs.local_transcription }}', step)
            self.assertIn('${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:transcription-${{ github.sha }}', step)
        for required in ['docker run --rm', '--platform linux/arm64', '--network none', '--read-only',
                         '--cap-drop ALL', '--security-opt no-new-privileges',
                         '--tmpfs /data/transcription:rw,nosuid,nodev,mode=0700,uid=1001,gid=1001',
                         '--entrypoint /sbin/tini "$IMAGE" -- sh tools/local-transcription-image/preflight.sh']:
            self.assertIn(required, preflight)
        for forbidden in ['secrets.', 'GITHUB_TOKEN', 'DISCORD_TOKEN', 'docker.sock', '--env', '--volume', '--mount', 'docker push']:
            self.assertNotIn(forbidden, preflight)
        for required in ['59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e',
                         'sha256sum -c -', '--network none', '--read-only',
                         'source=$FIXTURE,target=/fixtures/jfk.wav,readonly',
                         '-- node tools/local-transcription-image/public-helper.js']:
            self.assertIn(required, public)
        for forbidden in ['secrets.', 'DISCORD_TOKEN', 'docker.sock', 'docker push']:
            self.assertNotIn(forbidden, public)
        self.assertIn('run: docker push "$IMAGE"', push)
        self.assertNotIn('build-push-action', push)  # publish the tested bytes, no rebuild

    def test_preflight_and_smoke_are_offline_public_only(self):
        preflight = Path('tools/local-transcription-image/preflight.sh').read_text()
        smoke = Path('tools/local-transcription-image/smoke.py').read_text()
        self.assertIn('node --test test/local-transcription/*.test.js', preflight)
        self.assertIn('test -z "${DISCORD_TOKEN:-}"', preflight)
        self.assertIn("'--network', 'none'", smoke)
        self.assertIn('59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e', smoke)
        self.assertIn('second container excluded by OS flock', smoke)
        self.assertNotIn('client.login(', preflight + smoke)

if __name__ == '__main__':
    unittest.main(verbosity=2)
