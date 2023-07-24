// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ILossCoverer} from "./interfaces/ILossCoverer.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";
import {PoolConfig, LPConfig, FirstLossCover} from "./PoolConfig.sol";
import "./SharedDefs.sol";
import {Errors} from "./Errors.sol";

contract LossCoverer is ILossCoverer {
    PoolConfig public poolConfig;
    IPool public pool;
    IPoolVault public poolVault;
    IERC20 public asset;

    uint256 public processedLoss;

    // TODO permission
    // review question We need this block of code in multiple contracts. Shall we put it in a library?
    function setPoolConfig(PoolConfig _poolConfig) external {
        poolConfig = _poolConfig;

        address addr = _poolConfig.poolVault();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolVault = IPoolVault(addr);

        addr = _poolConfig.pool();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        pool = IPool(addr);

        addr = _poolConfig.underlyingToken();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        asset = IERC20(addr);
    }

    // TODO migration function

    // review question Please explain what this function does. It seems the function tries
    // to figure out the min coverage and transfer asset to a receiver.
    // The name removeLiquidity is confusing.It does not match with the logic in the function.
    function removeLiquidity(address receiver) external {
        // review question access control?
        uint256 assets = asset.balanceOf(address(this));
        if (assets == 0) return;

        LPConfig memory lpConfig = poolConfig.getLPConfig();
        FirstLossCover memory config = poolConfig.getFirstLossCover();
        uint256 poolCap = lpConfig.liquidityCap;
        uint256 minFromPoolCap = (poolCap * config.poolCapCoverageInBps) / HUNDRED_PERCENT_IN_BPS;
        uint256 poolValue = pool.totalAssets();
        uint256 minFromPoolValue = (poolValue * config.poolValueCoverageInBps) /
            HUNDRED_PERCENT_IN_BPS;
        uint256 min = minFromPoolCap > minFromPoolValue ? minFromPoolCap : minFromPoolValue;

        if (assets > min) {
            asset.transfer(receiver, assets - min);
        }
    }

    function coverLoss(uint256 poolAssets, uint256 loss) external returns (uint256 remainingLoss) {
        FirstLossCover memory config = poolConfig.getFirstLossCover();
        uint256 processed = (poolAssets * config.coverRateInBps) / HUNDRED_PERCENT_IN_BPS;
        processed = processed < config.coverCap ? processed : config.coverCap;

        uint256 assets = asset.balanceOf(address(this));
        processed = processed < assets ? processed : assets;
        remainingLoss = loss - processed;
        if (processed > 0) {
            processedLoss += processed;
            poolVault.deposit(address(this), processedLoss);
        }
    }

    // review question need to add function for replenishFirstLossCover.

    function recoverLoss(uint256 recovery) external returns (uint256 remainingRecovery) {
        uint256 processed = processedLoss;
        uint256 recovered = processed < recovery ? processed : recovery;
        // review question under which situation, remainingRecovery can be positive?
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

        LPConfig memory lpConfig = poolConfig.getLPConfig();
        FirstLossCover memory config = poolConfig.getFirstLossCover();
        uint256 poolCap = lpConfig.liquidityCap;
        if (assets < (poolCap * config.poolCapCoverageInBps) / HUNDRED_PERCENT_IN_BPS) {
            return false;
        }

        uint256 poolValue = pool.totalAssets();
        return assets >= (poolValue * config.poolValueCoverageInBps) / HUNDRED_PERCENT_IN_BPS;
    }
}
