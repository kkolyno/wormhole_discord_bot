"""Dependency-free image/workflow contract checks; run from repository root."""
from pathlib import Path
import unittest


class ImageContract(unittest.TestCase):
    def test_pinned_cpu_build_and_safe_default(self):
        dockerfile = Path("Dockerfile.oracle-test").read_text()
        self.assertEqual(dockerfile.count("node:22.22.0-alpine3.23@sha256:e4bf2a82ad0a4037d28035ae71529873c069b13eb0455466ae0bc13363826e34"), 2)
        for flag in ("GGML_NATIVE", "GGML_CUDA", "GGML_VULKAN", "GGML_METAL", "GGML_BLAS", "GGML_OPENMP", "WHISPER_BUILD_SERVER", "WHISPER_BUILD_TESTS", "WHISPER_CURL", "WHISPER_COREML", "WHISPER_OPENVINO"):
            self.assertIn(f"-D{flag}=OFF", dockerfile)
        self.assertIn("-DGGML_CPU_ARM_ARCH=armv8-a", dockerfile)
        self.assertIn("--parallel 4", dockerfile)
        self.assertIn('CMD ["node", "index.js"]', dockerfile)
        self.assertIn("USER nodejs", dockerfile)
        self.assertIn('ENTRYPOINT ["/sbin/tini", "--", "docker-entrypoint.sh"]', dockerfile)
        self.assertIn("chown -R 1001:1001 /data", dockerfile)
        self.assertIn("chmod 700 /data/oracle-test", dockerfile)
        self.assertEqual(dockerfile.count("--ignore-scripts"), 2)
        self.assertIn("COPY tools/oracle-test/*.js", dockerfile)
        self.assertNotIn("COPY tools/ ", dockerfile)
        self.assertNotIn("COPY . ", dockerfile)

    def test_verify_before_model_or_source_use(self):
        dockerfile = Path("Dockerfile.oracle-test").read_text()
        source_sha = "645445da884df6dbd52b30f82d7be7c01d1767c938714e477e786b88d529e9f4"
        model_sha = "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002"
        self.assertLess(dockerfile.index(source_sha), dockerfile.index("tar -xzf"))
        self.assertLess(dockerfile.index(model_sha), dockerfile.index("AS runtime"))
        self.assertIn("147964211", dockerfile)
        self.assertIn("5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.en.bin", dockerfile)
        self.assertNotIn("ggml-base.bin", dockerfile)

    def test_single_opt_in_feature_branch_test_publisher(self):
        workflow = Path(".github/workflows/docker-publish.yml").read_text()
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("oracle_test:", workflow)
        self.assertIn("default: false", workflow)
        self.assertIn("if: ${{ !inputs.oracle_test || github.ref != 'refs/heads/main' }}", workflow)
        self.assertIn("packages: write", workflow)
        self.assertIn("contents: read", workflow)
        self.assertIn("value=oracle-test-${{ github.sha }},enable=${{ inputs.oracle_test }}", workflow)
        self.assertIn("value=latest,enable=${{ github.ref == 'refs/heads/main' && !inputs.oracle_test }}", workflow)
        self.assertIn("file: ${{ inputs.oracle_test && 'Dockerfile.oracle-test' || 'Dockerfile' }}", workflow)
        self.assertIn("Test commit tag already exists", workflow)
        self.assertIn("cancel-in-progress: false", workflow)
        self.assertNotIn("ssh", workflow)
        self.assertFalse(Path(".github/workflows/oracle-test.yml").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
