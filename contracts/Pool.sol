// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IPool} from "./interfaces/IPool.sol";
import {IPlatformFeeManager} from "./interfaces/IPlatformFeeManager.sol";
import {ITranchesPolicy} from "./interfaces/ITranchesPolicy.sol";
import {ICredit} from "./credit/interfaces/ICredit.sol";
import {ILossCoverer} from "./interfaces/ILossCoverer.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";
import "./SharedDefs.sol";
import {PoolConfig} from "./PoolConfig.sol";
import {Errors} from "./Errors.sol";

contract Pool is IPool {
    struct TranchesInfo {
        uint96 seniorTotalAssets; // total assets of senior tranche
        uint96 juniorTotalAssets; // total assets of junior tranche
        uint64 lastUpdatedTime; // the updated timestamp of seniorTotalAssets and juniorTotalAssets
    }

    struct TranchesLosses {
        uint96 seniorLoss; // total losses of senior tranche
        uint96 juniorLoss; // total losses of junior tranche
    }

    PoolConfig public poolConfig;
    IPoolVault public poolVault;
    ITranchesPolicy public tranchesPolicy;
    ILossCoverer[] public lossCoverers;
    ICredit public credit;
    IPlatformFeeManager public feeManager;

    TranchesInfo public tranches;
    TranchesLosses public tranchesLosses;

    enum PoolStatus {
        Off,
        On
    }

    // Whether the pool is ON or OFF
    PoolStatus internal _status;

    event PoolDisabled(address indexed by);
    event PoolEnabled(address indexed by);

    function setPoolConfig(PoolConfig _poolConfig) external {
        poolConfig.onlyPoolOwner(msg.sender);

        poolConfig = _poolConfig;

        address addr = _poolConfig.poolVault();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolVault = IPoolVault(addr);

        addr = _poolConfig.tranchesPolicy();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        tranchesPolicy = ITranchesPolicy(addr);

        address[] memory coverers = _poolConfig.getLossCoverers();
        for (uint256 i = 0; i < coverers.length; i++) {
            lossCoverers[i] = ILossCoverer(coverers[i]);
        }

        addr = _poolConfig.credit();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        credit = ICredit(addr);

        addr = _poolConfig.feeManager();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        feeManager = IPlatformFeeManager(addr);
    }

    /**
     * @notice turns on the pool. Only the pool owner or protocol owner can enable a pool.
     */
    function enablePool() external {
        poolConfig.onlyOwnerOrHumaMasterAdmin(msg.sender);

        poolConfig.checkFirstLossCoverRequirement();

        _status = PoolStatus.On;
        emit PoolEnabled(msg.sender);
    }

    /**
     * @notice turns off the pool. Any pool operator can do so when they see abnormalities.
     */
    function disablePool() external {
        poolConfig.onlyPoolOperator(msg.sender);
        _status = PoolStatus.Off;
        emit PoolDisabled(msg.sender);
    }

    /// Gets the on/off status of the pool
    function isPoolOn() external view returns (bool status) {
        if (_status == PoolStatus.On) return true;
        else return false;
    }

    function refreshPool() external returns (uint96[2] memory) {
        poolConfig.onlyTrancheVaultOrEpochManager(msg.sender);

        (uint256 profit, uint256 loss, uint256 lossRecovery) = credit.refreshPnL();

        // distribute profit
        if (profit > 0) {
            _distributeProfit(profit);
        }

        if (loss > 0) {
            _distributeLoss(loss);
        }

        if (lossRecovery > 0) {
            _distributeLossRecovery(lossRecovery);
        }

        return [tranches.seniorTotalAssets, tranches.juniorTotalAssets];
    }

    function _distributeProfit(uint256 profit) internal {
        uint256 poolProfit = feeManager.distributePlatformFees(profit);

        if (poolProfit > 0) {
            TranchesInfo memory tranchesInfo = tranches;
            uint96[2] memory assets = [
                tranchesInfo.seniorTotalAssets,
                tranchesInfo.juniorTotalAssets
            ];
            assets = tranchesPolicy.calcTranchesAssetsForProfit(
                poolProfit,
                assets,
                tranchesInfo.lastUpdatedTime
            );

            tranchesInfo.seniorTotalAssets = assets[SENIOR_TRANCHE_INDEX];
            tranchesInfo.juniorTotalAssets = assets[JUNIOR_TRANCHE_INDEX];
            tranchesInfo.lastUpdatedTime = uint64(block.timestamp);
            tranches = tranchesInfo;
        }
    }

    function _distributeLoss(uint256 loss) internal {
        if (loss > 0) {
            TranchesInfo memory tranchesInfo = tranches;

            for (uint256 i; i < lossCoverers.length; i++) {
                ILossCoverer coverer = lossCoverers[i];
                loss = coverer.coverLoss(
                    tranchesInfo.seniorTotalAssets + tranchesInfo.juniorTotalAssets,
                    loss
                );
            }

            uint96[2] memory assets = [
                tranchesInfo.seniorTotalAssets,
                tranchesInfo.juniorTotalAssets
            ];
            assets = tranchesPolicy.calcTranchesAssetsForLoss(loss, assets);

            // store tranches info
            tranchesInfo.seniorTotalAssets = assets[SENIOR_TRANCHE_INDEX];
            tranchesInfo.juniorTotalAssets = assets[JUNIOR_TRANCHE_INDEX];
            tranchesInfo.lastUpdatedTime = uint64(block.timestamp);
            tranches = tranchesInfo;
        }
    }

    function _distributeLossRecovery(uint256 lossRecovery) internal {
        if (lossRecovery > 0) {
            TranchesInfo memory tranchesInfo = tranches;
            uint96[2] memory assets = [
                tranchesInfo.seniorTotalAssets,
                tranchesInfo.juniorTotalAssets
            ];
            TranchesLosses memory tsLosses = tranchesLosses;
            uint96[2] memory losses = [tsLosses.seniorLoss, tsLosses.juniorLoss];
            (lossRecovery, assets, losses) = tranchesPolicy.calcTranchesAssetsForLossRecovery(
                lossRecovery,
                assets,
                losses
            );

            tranchesInfo.seniorTotalAssets = assets[SENIOR_TRANCHE_INDEX];
            tranchesInfo.juniorTotalAssets = assets[JUNIOR_TRANCHE_INDEX];
            tranchesInfo.lastUpdatedTime = uint64(block.timestamp);
            tranches = tranchesInfo;

            tsLosses.seniorLoss = losses[SENIOR_TRANCHE_INDEX];
            tsLosses.juniorLoss = losses[JUNIOR_TRANCHE_INDEX];
            tranchesLosses = tsLosses;

            uint256 len = lossCoverers.length;
            for (uint256 i = 0; i < len; i++) {
                ILossCoverer coverer = lossCoverers[len - i - 1];
                lossRecovery = coverer.recoverLoss(lossRecovery);
            }
        }
    }

    function trancheTotalAssets(uint256 index) external view returns (uint256) {
        uint96[2] memory assets = currentTranchesAssets();
        return assets[index];
    }

    function totalAssets() external view returns (uint256) {
        uint96[2] memory assets = currentTranchesAssets();
        return assets[SENIOR_TRANCHE_INDEX] + assets[JUNIOR_TRANCHE_INDEX];
    }

    function currentTranchesAssets() public view returns (uint96[2] memory trancheAssets) {
        TranchesInfo memory ti = tranches;
        trancheAssets = [ti.seniorTotalAssets, ti.juniorTotalAssets];
        if (block.timestamp <= ti.lastUpdatedTime) {
            return trancheAssets;
        }

        (uint256 profit, uint256 loss, uint256 lossRecovery) = credit.currentPnL();

        if (profit > 0) {
            uint256 remaining = feeManager.getRemainingAfterPlatformFees(profit);
            if (remaining > 0) {
                trancheAssets = tranchesPolicy.calcTranchesAssetsForProfit(
                    remaining,
                    trancheAssets,
                    ti.lastUpdatedTime
                );
            }
        }

        if (loss > 0) {
            trancheAssets = tranchesPolicy.calcTranchesAssetsForLoss(loss, trancheAssets);
        }

        if (lossRecovery > 0) {
            TranchesLosses memory tsLosses = tranchesLosses;
            uint96[2] memory losses = [tsLosses.seniorLoss, tsLosses.juniorLoss];
            tranchesPolicy.calcTranchesAssetsForLossRecovery(lossRecovery, trancheAssets, losses);
        }
    }

    function submitRedemptionRequest(uint256 amounts) external {
        poolConfig.onlyEpochManager(msg.sender);

        poolVault.setRedemptionReserve(amounts);

        // :handle redemption request for flex loan
    }

    function updateTranchesAssets(uint96[2] memory assets) external {
        poolConfig.onlyTrancheVaultOrEpochManager(msg.sender);

        TranchesInfo memory ti = tranches;
        ti.seniorTotalAssets = assets[SENIOR_TRANCHE_INDEX];
        ti.juniorTotalAssets = assets[JUNIOR_TRANCHE_INDEX];
        tranches = ti;
    }
}
