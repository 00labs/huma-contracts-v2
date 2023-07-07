// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {BaseWaterfallPolicy} from "./BaseWaterfallPolicy.sol";

/**
 * @notice RiskAdjustedWaterfallPolicy is one tranche policy implementation. In this policy,
 * a percentage of the pool return is shifted from the senior tranche to the junior tranche.
 */
contract RiskAdjustedWaterfallPolicy is BaseWaterfallPolicy {
    uint16 public adjustRatio;

    /**
     * @notice Distribute profit between tranches.
     */
    function distributeProfit(
        uint256 profit,
        uint96[2] memory assets,
        uint256 lastUpdatedTime
    ) external view override returns (uint96[2] memory newAssets) {
        uint256 seniorAssets = assets[SENIOR_TRANCHE_INDEX];
        uint256 juniorAssets = assets[JUNIOR_TRANCHE_INDEX];
        uint256 seniorProfit = (profit * seniorAssets) / (seniorAssets + juniorAssets);
        uint256 adjustProfit = (seniorProfit * adjustRatio) / BPS_DECIMALS;
        seniorProfit = seniorProfit - adjustProfit;
        newAssets[SENIOR_TRANCHE_INDEX] = uint96(seniorAssets + seniorProfit);
        newAssets[JUNIOR_TRANCHE_INDEX] = uint96(juniorAssets + profit - seniorProfit);
    }
}
