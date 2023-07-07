// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IPool} from "./interfaces/IPool.sol";
import {IPlatformFeeManager} from "./interfaces/IPlatformFeeManager.sol";
import {IWaterfallPolicy} from "./waterfall/interfaces/IWaterfallPolicy.sol";
import {ICredit} from "./credit/interfaces/ICredit.sol";
import {ILossCoverer} from "./interfaces/ILossCoverer.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";
import {Constants} from "./Constants.sol";

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

contract Pool is Constants, IPool {
    ICredit public credit;
    IPlatformFeeManager public feeManager;
    IWaterfallPolicy public tranchePolicy;
    ILossCoverer[] public lossCoverers;
    IPoolVault public poolVault;

    FeeInfo public feeInfo;
    TranchesInfo public tranches;
    TranchesLosses public tranchesLosses;

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

            // calculate tranches assets after profit distribution
            uint96[2] memory assets = tranchePolicy.distributeProfit(
                remaining,
                [tranchesInfo.seniorTotalAssets, tranchesInfo.juniorTotalAssets],
                tranchesInfo.lastUpdatedTime
            );

            tranchesInfo.seniorTotalAssets = assets[SENIOR_TRANCHE_INDEX];
            tranchesInfo.juniorTotalAssets = assets[JUNIOR_TRANCHE_INDEX];
            tranchesInfo.lastUpdatedTime = uint64(block.timestamp);
            tranches = tranchesInfo;
        }
    }

    function _distributeLoss(uint256 loss) internal {
        for (uint256 i; i < lossCoverers.length; i++) {
            ILossCoverer coverer = lossCoverers[i];
            loss = coverer.coverLoss(loss);
        }

        if (loss > 0) {
            TranchesInfo memory tranchesInfo = tranches;
            uint96[2] memory assets = tranchePolicy.distributeLoss(
                loss,
                [tranchesInfo.seniorTotalAssets, tranchesInfo.juniorTotalAssets]
            );

            // store tranches info
            tranchesInfo.seniorTotalAssets = assets[SENIOR_TRANCHE_INDEX];
            tranchesInfo.juniorTotalAssets = assets[JUNIOR_TRANCHE_INDEX];
            tranchesInfo.lastUpdatedTime = uint64(block.timestamp);
            tranches = tranchesInfo;
        }
    }

    function _distributeLossRecovery(uint256 lossRecovery) internal {
        for (uint256 i; i < lossCoverers.length; i++) {
            ILossCoverer coverer = lossCoverers[i];
            lossRecovery = coverer.recoverLoss(lossRecovery);
        }

        if (lossRecovery > 0) {
            TranchesInfo memory tranchesInfo = tranches;
            uint96[2] memory assets = [
                tranchesInfo.seniorTotalAssets,
                tranchesInfo.juniorTotalAssets
            ];
            TranchesLosses memory tsLosses = tranchesLosses;
            uint96[2] memory losses = [tsLosses.seniorLoss, tsLosses.juniorLoss];
            tranchePolicy.distributeLossRecovery(lossRecovery, assets, losses);

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

    function _currentTranches() internal view returns (uint96[2] memory trancheAssets) {
        (uint256 profit, uint256 loss, uint256 lossRecovery) = credit.currentPnL();

        TranchesInfo memory ti = tranches;
        trancheAssets = [ti.seniorTotalAssets, ti.juniorTotalAssets];

        if (profit > 0) {
            uint256 remaining = feeManager.getRemaining(profit);
            if (remaining > 0) {
                trancheAssets = tranchePolicy.distributeProfit(
                    remaining,
                    trancheAssets,
                    ti.lastUpdatedTime
                );
            }
        }

        if (loss > 0) {
            trancheAssets = tranchePolicy.distributeLoss(loss, trancheAssets);
        }

        if (lossRecovery > 0) {
            TranchesLosses memory tsLosses = tranchesLosses;
            uint96[2] memory losses = [tsLosses.seniorLoss, tsLosses.juniorLoss];
            tranchePolicy.distributeLossRecovery(lossRecovery, trancheAssets, losses);
        }
    }

    function submitRedemptionRequest(uint256 amounts) external {
        poolVault.setReserveAssets(amounts);

        // :handle redemption request for flex loan
    }

    function updateTranchesAssets(uint96[2] memory assets) external {
        TranchesInfo memory ti = tranches;
        ti.seniorTotalAssets = assets[SENIOR_TRANCHE_INDEX];
        ti.juniorTotalAssets = assets[JUNIOR_TRANCHE_INDEX];
        tranches = ti;
    }
}
