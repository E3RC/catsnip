$hostname = "o-cloud"
$user = "root"

Write-Host "Waiting for $hostname to come online..." -ForegroundColor Yellow

while ($true) {
    $result = tailscale ssh $user@$hostname "echo alive" 2>&1
    if ($result -eq "alive") {
        Write-Host "Connected! Running rescue commands..." -ForegroundColor Green
        
        # 1. Kill the memory hog
        tailscale ssh $user@$hostname "systemctl stop zeroclaw; systemctl disable zeroclaw; pkill -9 zeroclaw 2>/dev/null; echo 'zeroclaw stopped'" 2>&1
        
        # 2. Install zram-generator if needed
        tailscale ssh $user@$hostname "rpm -q zram-generator 2>/dev/null || dnf install -y zram-generator" 2>&1
        
        # 3. Configure zram
        tailscale ssh $user@$hostname "echo '[zram0]
zram-size = ram / 2
compression-algorithm = zstd' > /etc/systemd/zram-generator.conf; systemctl daemon-reload; systemctl start systemd-zram-setup@zram0; echo 'zram configured'" 2>&1
        
        # 4. Set swappiness
        tailscale ssh $user@$hostname "echo 'vm.swappiness=10' > /etc/sysctl.d/99-swap.conf; sysctl -w vm.swappiness=10; echo 'swappiness set'" 2>&1
        
        # 5. Show result
        tailscale ssh $user@$hostname "free -h; echo '---'; swapon --show; echo '---'; systemctl restart tailscaled; echo 'rescue complete'" 2>&1
        
        Write-Host "Rescue complete! Server should be stable now." -ForegroundColor Green
        break
    }
    Write-Host "." -NoNewline
    Start-Sleep -Seconds 5
}
