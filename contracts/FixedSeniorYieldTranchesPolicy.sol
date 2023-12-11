// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {BaseTranchesPolicy} from "./BaseTranchesPolicy.sol";
import {LPConfig} from "./PoolConfig.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {SENIOR_TRANCHE, JUNIOR_TRANCHE, SECONDS_IN_A_YEAR, HUNDRED_PERCENT_IN_BPS} from "./SharedDefs.sol";

//import "hardhat/console.sol";

/**
 * @notice Tranche policy when the yield for the senior tranche is fixed as long as
 * the risk loss does not make it impossible.
 */
contract FixedSeniorYieldTranchePolicy is BaseTranchesPolicy {
    struct SeniorYieldData {
        uint96 seniorDebt;
        uint96 unpaidYield;
        uint64 lastUpdatedDate;
    }

    SeniorYieldData public seniorYieldData;

    function refreshData(uint96[2] memory assets) public override {
        SeniorYieldData memory seniorData = _getSeniorData();
        seniorData.seniorDebt = assets[SENIOR_TRANCHE];
        seniorYieldData = seniorData;
    }

    function distProfitToTranches(
        uint256 profit,
        uint96[2] memory assets
    ) external returns (uint96[2] memory newAssets) {
        SeniorYieldData memory seniorData = _getSeniorData();

        uint256 seniorProfit = seniorData.unpaidYield > profit ? profit : seniorData.unpaidYield;
        uint256 juniorProfit = profit - seniorProfit;

        newAssets[SENIOR_TRANCHE] = assets[SENIOR_TRANCHE] + uint96(seniorProfit);
        newAssets[JUNIOR_TRANCHE] = assets[JUNIOR_TRANCHE] + uint96(juniorProfit);

        seniorData.unpaidYield -= uint96(seniorProfit);
        seniorData.seniorDebt = newAssets[SENIOR_TRANCHE];
        seniorYieldData = seniorData;

        return newAssets;
    }

    function _getSeniorData() public view returns (SeniorYieldData memory) {
        SeniorYieldData memory seniorData = seniorYieldData;
        if (block.timestamp > seniorData.lastUpdatedDate) {
            LPConfig memory lpConfig = poolConfig.getLPConfig();
            seniorData.unpaidYield = uint96(
                (seniorData.seniorDebt *
                    lpConfig.fixedSeniorYieldInBps *
                    (block.timestamp - seniorData.lastUpdatedDate)) /
                    SECONDS_IN_A_YEAR /
                    HUNDRED_PERCENT_IN_BPS
            );
            seniorData.lastUpdatedDate = uint64(block.timestamp);
        }

        return seniorData;
    }
}
