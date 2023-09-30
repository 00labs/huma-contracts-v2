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
    function distProfitToTranches(
        uint256 profit,
        uint96[2] memory assets,
        uint256 lastUpdatedTime
    ) external view returns (uint96[2] memory newAssets) {
        uint256 poolSafeAssets = IPoolSafe(poolConfig.poolSafe()).getPoolAssets();
        uint256 totalAssets = assets[SENIOR_TRANCHE] + assets[JUNIOR_TRANCHE];
        // todo deployedTotalAssets below is not really true deployedTotalAsset.
        // It is the total asset in the pool including the undeployed. For the calculation
        // in this contract, we should use deployed. Overall: there are three kind of
        // assets related to the pool: deployed (borrowed by the borrowers), idle in the pool,
        // saved in the safe.
        uint256 deployedTotalAssets = totalAssets - poolSafeAssets;

        // todo this calculation might be flawed. It assumed the same distribution of senior in
        // the safe as the overall pool. This is not always the case.
        uint256 deployedSeniorAssets = (deployedTotalAssets * assets[SENIOR_TRANCHE]) /
            totalAssets;

        uint256 seniorProfit;
        if (block.timestamp > lastUpdatedTime) {
            LPConfig memory lpConfig = poolConfig.getLPConfig();
            seniorProfit =
                (deployedSeniorAssets *
                    lpConfig.fixedSeniorYieldInBps *
                    (block.timestamp - lastUpdatedTime)) /
                SECONDS_IN_A_YEAR /
                HUNDRED_PERCENT_IN_BPS;
        }

        // TODO calculate senior apr last updated timestamp if profit < seniorProfit?
        seniorProfit = seniorProfit > profit ? profit : seniorProfit;
        uint256 juniorProfit = profit - seniorProfit;

        //console.log("seniorProfit: %s, juniorProfit: %s", seniorProfit, juniorProfit);

        newAssets[SENIOR_TRANCHE] = assets[SENIOR_TRANCHE] + uint96(seniorProfit);
        newAssets[JUNIOR_TRANCHE] = assets[JUNIOR_TRANCHE] + uint96(juniorProfit);
        return newAssets;
    }
}
