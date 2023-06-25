// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ITranchePolicy} from "./interfaces/ITranchePolicy.sol";

/**
 * @notice RiskAdjustedTranchePolicy is one tranche policy implementation. In this policy,
 * a percentage of the pool return is shifted from the senior tranche to the junior tranche.
 */
contract RiskAdjustedTranchePolicy is ITranchePolicy {
    uint16 public adjustRatio;

    /**
     * @notice Distribute profit between tranches.
     */
    function distributeProfit(
        uint256 profit,
        uint96[2] memory assets,
        uint256 lastUpdatedTime
    ) external view override returns (uint96[2] memory) {}

    /**
     * @notice Distribute losses between tranches.
     */
    function distributeLoss(
        uint256 loss,
        uint96[2] memory assets,
        uint256 lastUpdatedTime
    ) external view returns (uint96[2] memory) {}
}
