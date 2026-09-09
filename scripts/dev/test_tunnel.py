"""Exercise tunnel routing without contacting Cloudflare or using real credentials."""

import base64
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("tunnel.sh")
HOST = "dev-sam.uat.example.com"
LIVE_KEY = "pk_live_" + base64.b64encode(b"clerk.uat.example.com$").decode()


class TunnelTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env_file = self.root / "env"
        self.calls = self.root / "calls"
        self.config = self.root / "capy-dev-sam.yml"
        (self.root / "cert.pem").touch()
        (self.root / "test-tunnel.json").write_text("{}")
        binary = self.root / "cloudflared"
        binary.write_text(
            "#!/usr/bin/env bash\n"
            'printf "%s\\n" "$*" >> "$TUNNEL_TEST_CALLS"\n'
            'case "$*" in\n'
            '  "tunnel list --output json")\n'
            '    printf \'[{"name":"capy-dev-sam","id":"test-tunnel"}]\\n\' ;;\n'
            '  "tunnel route dns capy-dev-sam "*) ;;\n'
            '  "tunnel --config "*) ;;\n'
            "  *) exit 1 ;;\n"
            "esac\n"
        )
        binary.chmod(0o755)

    def run_tunnel(self, key, host=HOST, port="", setup_only=True):
        self.env_file.write_text(
            f"CLERK_WEBHOOK_HOST={host}\nVITE_CLERK_PUBLISHABLE_KEY={key}\n"
            f"VITE_PORT={port}\nADDR=:8081\n"
        )
        env = dict(os.environ)
        env.pop("CAPY_DEV_TUNNEL_NAME", None)
        env.update(
            PATH=f"{self.root}{os.pathsep}{env['PATH']}",
            CAPY_ENV_FILE=str(self.env_file),
            CLOUDFLARED_HOME=str(self.root),
            TUNNEL_TEST_CALLS=str(self.calls),
        )
        return subprocess.run(
            ["bash", str(SCRIPT), *(["--setup-only"] if setup_only else [])],
            env=env,
            capture_output=True,
            check=False,
            text=True,
            timeout=10,
        )

    def test_development_key_exposes_only_webhooks_without_vite_port(self):
        dev = self.run_tunnel("pk_test_synthetic", setup_only=False)
        self.assertEqual(dev.returncode, 0, dev.stderr)
        self.assertEqual(
            self.config.read_text().split("ingress:\n")[1],
            f"  - hostname: {HOST}\n"
            "    path: ^/webhooks/\n"
            "    service: http://localhost:8081\n"
            "  - service: http_status:404\n",
        )
        self.assertIn("Run `pnpm dev` on localhost", dev.stdout)
        self.assertNotIn("pnpm dev:public", dev.stdout)
        self.assertIn(
            f"tunnel --config {self.config} run capy-dev-sam", self.calls.read_text()
        )

    def test_invalid_configuration_stops_before_cloudflare(self):
        for key, host in [
            (LIVE_KEY, HOST),
            ("", HOST),
            ("invalid", HOST),
        ]:
            with self.subTest(key=key, host=host):
                result = self.run_tunnel(key, host=host, port="5173")
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.calls.exists())
                self.assertFalse(self.config.exists())


if __name__ == "__main__":
    unittest.main()
