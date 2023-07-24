// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {BaseTranchesPolicy} from "./BaseTranchesPolicy.sol";
import {PoolConfig, LPConfig} from "./PoolConfig.sol";
import {Errors} from "./Errors.sol";
import "./SharedDefs.sol";

/**
 * @notice This is fixed yield implementation. In the fixed yield mode,
 * the yield for the senior tranches is fixed as long as the risk loss does not make this impossible.
 */

contract FixedAprTranchesPolicy is BaseTranchesPolicy {
    constructor(PoolConfig _poolConfig) BaseTranchesPolicy(_poolConfig) {}

    function distributeProfit(
        uint256 profit,
        uint96[2] memory assets,
        uint256 lastUpdatedTime
    ) external view {
        // review question the distribution should be based on total deployed asset instead of total asset
        uint256 seniorTotalAssets = assets[SENIOR_TRANCHE_INDEX];
        uint256 seniorProfit;
        if (block.timestamp > lastUpdatedTime) {
            LPConfig memory lpConfig = poolConfig.getLPConfig();
            seniorProfit =
                (seniorTotalAssets *
                    lpConfig.fixedSeniorYieldInBps *
                    (block.timestamp - lastUpdatedTime)) /
                SECONDS_IN_A_YEAR /
                HUNDRED_PERCENT_IN_BPS;
        }

        seniorProfit = seniorProfit > profit ? profit : seniorProfit;
        uint256 juniorProfit = profit - seniorProfit;

        assets[SENIOR_TRANCHE_INDEX] = assets[SENIOR_TRANCHE_INDEX] + uint96(seniorProfit);
        assets[JUNIOR_TRANCHE_INDEX] = assets[JUNIOR_TRANCHE_INDEX] + uint96(juniorProfit);
    }
}
