// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IPool} from "./interfaces/IPool.sol";
import {IPlatformFeeManager} from "./interfaces/IPlatformFeeManager.sol";
import {ITranchesPolicy} from "./interfaces/ITranchesPolicy.sol";
import {ICredit} from "./credit/interfaces/ICredit.sol";
import {ILossCoverer} from "./interfaces/ILossCoverer.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";
import "./Constants.sol";
import {PoolConfig} from "./PoolConfig.sol";
import {Errors} from "./Errors.sol";

contract Pool is IPool {
    struct FeeInfo {
        uint96 protocolFee;
        uint96 ownerFee;
        // todo add eaFee and firstLossCoverFee
    }

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

    FeeInfo public feeInfo;
    TranchesInfo public tranches;
    TranchesLosses public tranchesLosses;

    // TODO permission
    function setPoolConfig(PoolConfig _poolConfig) external {
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

    // TODO migration function

    function refreshPool() external returns (uint96[2] memory) {
        // check permission

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
        uint256 remaining = feeManager.distributePlatformFees(profit);

        if (remaining > 0) {
            TranchesInfo memory tranchesInfo = tranches;
            uint96[2] memory assets = [
                tranchesInfo.seniorTotalAssets,
                tranchesInfo.juniorTotalAssets
            ];
            tranchesPolicy.distributeProfit(remaining, assets, tranchesInfo.lastUpdatedTime);

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
            tranchesPolicy.distributeLoss(loss, assets);

            // store tranches info
            tranchesInfo.seniorTotalAssets = assets[SENIOR_TRANCHE_INDEX];
            tranchesInfo.juniorTotalAssets = assets[JUNIOR_TRANCHE_INDEX];
            tranchesInfo.lastUpdatedTime = uint64(block.timestamp);
            tranches = tranchesInfo;
        }
    }

    function _distributeLossRecovery(uint256 lossRecovery) internal {
        if (lossRecovery > 0) {
            uint256 len = lossCoverers.length;
            for (uint256 i = 0; i < len; i++) {
                ILossCoverer coverer = lossCoverers[len - i - 1];
                lossRecovery = coverer.recoverLoss(lossRecovery);
            }

            TranchesInfo memory tranchesInfo = tranches;
            uint96[2] memory assets = [
                tranchesInfo.seniorTotalAssets,
                tranchesInfo.juniorTotalAssets
            ];
            TranchesLosses memory tsLosses = tranchesLosses;
            uint96[2] memory losses = [tsLosses.seniorLoss, tsLosses.juniorLoss];
            tranchesPolicy.distributeLossRecovery(lossRecovery, assets, losses);

            tranchesInfo.seniorTotalAssets = assets[SENIOR_TRANCHE_INDEX];
            tranchesInfo.juniorTotalAssets = assets[JUNIOR_TRANCHE_INDEX];
            tranchesInfo.lastUpdatedTime = uint64(block.timestamp);
            tranches = tranchesInfo;

            tsLosses.seniorLoss = losses[SENIOR_TRANCHE_INDEX];
            tsLosses.juniorLoss = losses[JUNIOR_TRANCHE_INDEX];
            tranchesLosses = tsLosses;
        }
    }

    function trancheTotalAssets(uint256 index) external view returns (uint256) {
        if (block.timestamp > tranches.lastUpdatedTime) {
            // need to update tranche assets

            // update tranche assets to current time
            uint96[2] memory assets = _currentTranches();

            return assets[index];
        } else {
            return
                index == SENIOR_TRANCHE_INDEX
                    ? tranches.seniorTotalAssets
                    : tranches.juniorTotalAssets;
        }
    }

    function totalAssets() external view returns (uint256) {
        if (block.timestamp > tranches.lastUpdatedTime) {
            // need to update tranche assets

            // update tranche assets to current time
            uint96[2] memory assets = _currentTranches();

            return assets[SENIOR_TRANCHE_INDEX] + assets[JUNIOR_TRANCHE_INDEX];
        } else {
            return tranches.seniorTotalAssets + tranches.juniorTotalAssets;
        }
    }

    function _currentTranches() internal view returns (uint96[2] memory trancheAssets) {
        (uint256 profit, uint256 loss, uint256 lossRecovery) = credit.currentPnL();

        TranchesInfo memory ti = tranches;
        trancheAssets = [ti.seniorTotalAssets, ti.juniorTotalAssets];

        if (profit > 0) {
            uint256 remaining = feeManager.getRemainingAfterPlatformFees(profit);
            if (remaining > 0) {
                tranchesPolicy.distributeProfit(remaining, trancheAssets, ti.lastUpdatedTime);
            }
        }

        if (loss > 0) {
            tranchesPolicy.distributeLoss(loss, trancheAssets);
        }

        if (lossRecovery > 0) {
            TranchesLosses memory tsLosses = tranchesLosses;
            uint96[2] memory losses = [tsLosses.seniorLoss, tsLosses.juniorLoss];
            tranchesPolicy.distributeLossRecovery(lossRecovery, trancheAssets, losses);
        }
    }

    function submitRedemptionRequest(uint256 amounts) external {
        poolVault.setRedemptionReserve(amounts);

        // :handle redemption request for flex loan
    }

    function updateTranchesAssets(uint96[2] memory assets) external {
        TranchesInfo memory ti = tranches;
        ti.seniorTotalAssets = assets[SENIOR_TRANCHE_INDEX];
        ti.juniorTotalAssets = assets[JUNIOR_TRANCHE_INDEX];
        tranches = ti;
    }
}
