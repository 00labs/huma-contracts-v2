// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IPool} from "./interfaces/IPool.sol";
import {IPlatformFeeManager} from "./interfaces/IPlatformFeeManager.sol";
import {ITranchePolicy} from "./interfaces/ITranchePolicy.sol";
import {ICredit} from "./credit/interfaces/ICredit.sol";

struct FeeInfo {
    uint96 protocolFee;
    uint96 ownerFee;
    // todo add eaFee and firstLossCoverFee
}

struct TranchesInfo {
    uint96 seniorTotalAssets; // total assets of senior tranche
    uint96 juniorTotalAssets; // total assets of junior tranche
    uint256 lastUpdatedTime; // the updated timestamp of seniorTotalAssets and juniorTotalAssets
}

contract Pool is IPool {
    uint256 public constant SENIOR_TRANCHE_INDEX = 0;
    uint256 public constant JUNIOR_TRANCHE_INDEX = 1;

    ICredit public credit;
    IPlatformFeeManager public feeManager;
    ITranchePolicy public tranchePolicy;

    FeeInfo public feeInfo;
    TranchesInfo public tranches;

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
        // calculate fees and tranches assets
        uint256 remaining = feeManager.distributePlatformFees(profit);

        if (remaining > 0) {
            // calculate tranches assets after profit distribution
            uint96[2] memory assets = tranchePolicy.distributeProfit(
                remaining,
                [tranches.seniorTotalAssets, tranches.juniorTotalAssets],
                tranches.lastUpdatedTime
            );

            // store tranches info
            tranches.seniorTotalAssets = assets[0];
            tranches.juniorTotalAssets = assets[1];
            tranches.lastUpdatedTime = block.timestamp;
        }
    }

    function _distributeLoss(uint256 loss) internal {
        // :reference v1 contract
    }

    function _distributeLossRecovery(uint256 lossRecovery) internal {}

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
            trancheAssets = tranchePolicy.distributeLoss(loss, trancheAssets, ti.lastUpdatedTime);
        }

        if (lossRecovery > 0) {
            trancheAssets = tranchePolicy.distributeLossRecovery(
                lossRecovery,
                trancheAssets,
                ti.lastUpdatedTime
            );
        }
    }

    function submitPrincipalWithdrawal(uint256 amount) external {
        credit.submitPrincipalWithdrawal(amount);
    }
}
