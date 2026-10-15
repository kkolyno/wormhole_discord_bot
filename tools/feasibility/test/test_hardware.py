import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("hardware", Path(__file__).parents[1] / "hardware.py")
hardware = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hardware)


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def put(self, name, data):
        p = self.root / name.lstrip("/")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data.encode())

    def test_allowlist_and_missing(self):
        self.put('/proc/device-tree/model', 'FriendlyElec fixture\0')
        self.put('/proc/device-tree/compatible', 'rockchip,rk3588\0vendor,board\0')
        self.put('/etc/os-release', 'ID=debian\nVERSION_ID="12"\nPRETTY_NAME="Fixture"\nSECRET=not-allowed\n')
        self.put('/proc/meminfo', 'MemTotal: 8000000 kB\nMemAvailable: 4000000 kB\nSwapTotal: 50 kB')
        self.put('/proc/loadavg', '0.1 0.2 0.3 4/999 12345')
        self.put('/proc/cpuinfo', 'processor : 0\nCPU part : 0xd0b\nSerial : secret\n\nprocessor : 1\nCPU part : 0xd05\n')
        self.put('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq', '1800000')
        self.put('/sys/class/thermal/thermal_zone0/type', 'soc-thermal')
        self.put('/sys/class/thermal/thermal_zone0/temp', '41000')
        self.put('/sys/class/thermal/thermal_zone0/trip_point_0_temp', '80000')
        self.put('/sys/module/rknpu/version', 'fixture-1')
        self.put('/dev/dri/renderD128', '')
        self.put('/usr/lib/librknnrt.so', 'must-not-be-read')
        with patch('subprocess.run', side_effect=AssertionError('no fixture commands')):
            result = hardware.Snapshot(self.root, runtime={'arch': 'aarch64', 'kernel': 'fixture'}, commands=True).collect()
        self.assertEqual(result['cpu']['logical_count'], 2)
        self.assertEqual(len(result['cpu']['types']), 2)
        self.assertEqual(result['thermal_zones'][0]['temp_millidegrees_c'], '41000')
        self.assertEqual(result['load_1_5_15'], ['0.1', '0.2', '0.3'])
        self.assertEqual(result['model'], 'FriendlyElec fixture')
        self.assertTrue(result['rknnrt_candidates_exist']['/usr/lib/librknnrt.so'])
        self.assertEqual(result['cpu']['frequency_khz_governor'][0]['scaling_governor']['status'], 'unknown')
        text = hardware.json.dumps(result)
        for forbidden in ['secret', 'SECRET', 'Serial', '12345', 'must-not-be-read', 'SwapTotal']:
            self.assertNotIn(forbidden, text)

    def test_empty_root_explicit_unknown(self):
        result = hardware.Snapshot(self.root).collect()
        for field in ('model', 'compatible', 'thermal_zones', 'device_nodes', 'rknpu_module_version'):
            self.assertEqual(result[field]['status'], 'unknown')
        self.assertEqual(result['runtime']['arch']['status'], 'unknown')
        self.assertEqual(result['versions']['node']['reason'], 'not_run')

    def test_read_permission_and_size(self):
        snap = hardware.Snapshot(self.root)
        with patch.object(Path, 'open', side_effect=PermissionError):
            self.assertEqual(snap.text('/proc/meminfo')['reason'], 'permission_denied')
        self.put('/proc/meminfo', 'x' * 65537)
        self.assertEqual(snap.text('/proc/meminfo')['reason'], 'oversize')

    def test_host_versions_never_execute_path_wrappers(self):
        snap = hardware.Snapshot('/', runtime={'arch': 'fixture', 'kernel': 'fixture'}, commands=True)
        self.assertEqual(snap.version('arbitrary-command')['reason'], 'not_allowlisted')
        with patch('shutil.which', side_effect=AssertionError('no executable discovery')), \
             patch('subprocess.run', side_effect=AssertionError('no subprocess execution')):
            self.assertEqual(snap.version('node'), hardware.unknown('not_run'))
            self.assertEqual(snap.version('docker'), hardware.unknown('not_run'))

    def test_enumeration_stops_at_limit(self):
        def entries():
            yield '/fixture/cpu1'
            yield '/fixture/cpu0'
            raise AssertionError('enumeration must stop at limit')
        with patch.object(hardware.glob, 'iglob', return_value=entries()):
            self.assertEqual(hardware.Snapshot(self.root).paths('/fixed/*', 2),
                             ['/fixture/cpu0', '/fixture/cpu1'])


if __name__ == '__main__':
    unittest.main()
