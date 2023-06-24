// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IPool} from "./interfaces/IPool.sol";
import {IFeeManager} from "./interfaces/IFeeManager.sol";
import {ITranchePolicy} from "./interfaces/ITranchePolicy.sol";
import {ICredit} from "./credit/interfaces/ICredit.sol";

struct FeeInfo {
    uint96 protocolFee;
    uint96 ownerFee;
}

struct TranchesInfo {
    uint96 seniorTotalAssets; // total assets of senior tranche
    uint96 juniorTotalAssets; // total assets of junior tranche
    uint256 lastUpdatedTime; // the updated timestamp of seniorTotalAssets and juniorTotalAssets
}

contract DealPortfolioPool is IPool {
    uint256 public constant SENIOR_TRANCHE_INDEX = 1;
    uint256 public constant JUNIOR_TRANCHE_INDEX = 2;

    ICredit public credit;
    IFeeManager public feeManager;
    ITranchePolicy public trancheLogic;

    FeeInfo public feeInfo;
    TranchesInfo public tranches;

    function trancheTotalAssets(uint256 index) external view returns (uint256) {
        if (block.timestamp > tranches.lastUpdatedTime) {
            // need to update tranche assets

            // update tranche assets to current time
            uint96[2] memory assets = _calculateLatestTranches();

            return index == SENIOR_TRANCHE_INDEX ? assets[0] : assets[1];
        } else {
            return
                index == SENIOR_TRANCHE_INDEX
                    ? tranches.seniorTotalAssets
                    : tranches.juniorTotalAssets;
        }
    }

    function refreshPool() external returns (uint96[2] memory) {
        // check permission

        uint256 profit = credit.updateProfit();

        // distribute profit
        if (profit > 0) {
            _processProfit(profit);
        }

        return [tranches.seniorTotalAssets, tranches.juniorTotalAssets];
    }

    function _calculateLatestTranches() internal view returns (uint96[2] memory trancheAssets) {
        uint256 profit = credit.calculateProfit();

        if (profit > 0) {
            // distribute profit
            (, trancheAssets) = _calculateProfitDistribution(profit);
        } else {
            trancheAssets = [tranches.seniorTotalAssets, tranches.juniorTotalAssets];
        }
    }

    function _calculateProfitDistribution(
        uint256 profit
    ) internal view returns (uint96[] memory fees, uint96[2] memory assets) {
        // calculate fees
        uint256[] memory feeParams = new uint256[](3);
        feeParams[0] = profit;
        (uint256 protocolFee, uint256 ownerFee, uint256 remaining) = feeManager.calculateFees(
            feeParams
        );
        fees[0] = uint96(protocolFee);
        fees[1] = uint96(ownerFee);

        if (remaining > 0) {
            // calculate tranches assets after profit distribution
            assets = trancheLogic.distributeProfit(
                remaining,
                [tranches.seniorTotalAssets, tranches.juniorTotalAssets],
                tranches.lastUpdatedTime
            );
        }
    }

    function _processProfit(uint256 profit) internal {
        // calculate fees and tranches assets
        (uint96[] memory fees, uint96[2] memory assets) = _calculateProfitDistribution(profit);

        // store fees info
        feeInfo.protocolFee += fees[0];
        feeInfo.ownerFee += fees[1];

        // store tranches info
        tranches.seniorTotalAssets = assets[0];
        tranches.juniorTotalAssets = assets[1];
        tranches.lastUpdatedTime = block.timestamp;
    }
}
