// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {BaseTranchesPolicy} from "./BaseTranchesPolicy.sol";
import {PoolConfig, LPConfig} from "./PoolConfig.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";
import {Errors} from "./Errors.sol";
import "./SharedDefs.sol";

import "hardhat/console.sol";

/**
 * @notice This is fixed yield implementation. In the fixed yield mode,
 * the yield for the senior tranches is fixed as long as the risk loss does not make this impossible.
 */

contract FixedAprTranchesPolicy is BaseTranchesPolicy {
    function calcTranchesAssetsForProfit(
        uint256 profit,
        uint96[2] memory assets,
        uint256 lastUpdatedTime
    ) external view returns (uint96[2] memory newAssets) {
        uint256 poolVaultAssets = IPoolVault(poolConfig.poolVault()).getPoolAssets();
        uint256 totalAssets = assets[SENIOR_TRANCHE_INDEX] + assets[JUNIOR_TRANCHE_INDEX];
        uint256 deployedTotalAssets = totalAssets - poolVaultAssets;
        uint256 deployedSeniorAssets = (deployedTotalAssets * assets[SENIOR_TRANCHE_INDEX]) /
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

        console.log("seniorProfit: %s, juniorProfit: %s", seniorProfit, juniorProfit);

        newAssets[SENIOR_TRANCHE_INDEX] = assets[SENIOR_TRANCHE_INDEX] + uint96(seniorProfit);
        newAssets[JUNIOR_TRANCHE_INDEX] = assets[JUNIOR_TRANCHE_INDEX] + uint96(juniorProfit);
        return newAssets;
    }
}
