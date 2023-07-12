// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ILossCoverer} from "./interfaces/ILossCoverer.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";
import {PoolConfig, LPConfig} from "./PoolConfig.sol";
import {Constants} from "./Constants.sol";

contract LossCoverer is Constants, ILossCoverer {
    struct Config {
        uint16 poolCapPercent;
        uint16 poolValuePercent;
        uint16 lossCoverPercent;
        uint96 lossCoverCap;
    }

    PoolConfig public poolConfig;
    IPool public pool;
    IPoolVault public poolVault;
    IERC20 public asset;

    Config public config;
    uint256 public processedLoss;

    // TODO permission
    function setPoolConfig(PoolConfig _poolConfig) external {
        poolConfig = _poolConfig;
        // :set poolVault
        // :set pool
        // :set asset
    }

    // TODO migration function

    function removeLiquidity(address receiver) external {
        uint256 assets = asset.balanceOf(address(this));
        if (assets == 0) return;

        Config memory cfg = config;
        //uint256 poolCap = poolConfig.lpConfig().liquidityCap();
        // todo fix it
        uint256 poolCap = 1;
        uint256 minFromPoolCap = (poolCap * cfg.poolCapPercent) / BPS_DECIMALS;
        uint256 poolValue = pool.totalAssets();
        uint256 minFromPoolValue = (poolValue * cfg.poolValuePercent) / BPS_DECIMALS;
        uint256 min = minFromPoolCap > minFromPoolValue ? minFromPoolCap : minFromPoolValue;

        if (assets > min) {
            asset.transfer(receiver, assets - min);
        }
    }

    function coverLoss(uint256 poolAssets, uint256 loss) external returns (uint256 remainingLoss) {
        Config memory cfg = config;
        uint256 processed = (poolAssets * cfg.lossCoverPercent) / BPS_DECIMALS;
        processed = processed < cfg.lossCoverCap ? processed : cfg.lossCoverCap;

        uint256 assets = asset.balanceOf(address(this));
        processed = processed < assets ? processed : assets;
        remainingLoss = loss - processed;
        if (processed > 0) {
            processedLoss += processed;
            poolVault.deposit(address(this), processedLoss);
        }
    }

    function recoverLoss(uint256 recovery) external returns (uint256 remainingRecovery) {
        uint256 processed = processedLoss;
        uint256 recovered = processed < recovery ? processed : recovery;
        remainingRecovery = recovery - recovered;
        if (recovered > 0) {
            processedLoss = processed - recovered;
            poolVault.withdraw(address(this), recovered);
        }
    }

    function isSufficient() external view returns (bool) {
        uint256 assets = asset.balanceOf(address(this));
        if (assets == 0) {
            return false;
        }

        Config memory cfg = config;
        //uint256 poolCap = poolConfig.liquidityCap();
        // todo fix it
        uint256 poolCap = 1;
        if (assets < (poolCap * cfg.poolCapPercent) / BPS_DECIMALS) {
            return false;
        }

        uint256 poolValue = pool.totalAssets();
        if (assets < (poolValue * cfg.poolValuePercent) / BPS_DECIMALS) {
            return false;
        } else {
            return true;
        }
    }
}
