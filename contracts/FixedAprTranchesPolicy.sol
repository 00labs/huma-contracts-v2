// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {BaseTranchesPolicy} from "./BaseTranchesPolicy.sol";

/**
 * @notice This is fixed yield implementation. In the fixed yield mode,
 * the yield for the senior tranches is fixed as long as the risk loss does not make this impossible.
 */

contract FixedAprTranchesPolicy is BaseTranchesPolicy {
    uint256 public constant SECONDS_IN_A_YEAR = 365 days;

    uint16 public seniorAprsInBps;

    function distributeProfit(
        uint256 profit,
        uint96[2] memory assets,
        uint256 lastUpdatedTime
    ) external view override returns (uint96[2] memory newAssets) {
        uint256 seniorTotalAssets = assets[SENIOR_TRANCHE_INDEX];
        uint256 seniorProfit;
        if (block.timestamp > 0) {
            seniorProfit =
                (seniorTotalAssets * seniorAprsInBps * (block.timestamp - lastUpdatedTime)) /
                SECONDS_IN_A_YEAR /
                BPS_DECIMALS;
        }

        seniorProfit = seniorProfit > profit ? profit : seniorProfit;
        uint256 juniorProfit = profit - seniorProfit;

        newAssets[SENIOR_TRANCHE_INDEX] = assets[SENIOR_TRANCHE_INDEX] + uint96(seniorProfit);
        newAssets[JUNIOR_TRANCHE_INDEX] = assets[JUNIOR_TRANCHE_INDEX] + uint96(juniorProfit);
    }
}
