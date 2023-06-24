// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ITranchePolicy} from "./interfaces/ITranchePolicy.sol";

/**
 * @notice This is risk-adjusted yield implementation. In the risk-adjusted yield,
 * a percentage of the return is shifted from the senior tranche to the junior tranche.
 */

contract AdjustYieldTrancheLogic is ITranchePolicy {
    uint16 public adjustRatio;

    function distributeProfit(
        uint256 profit,
        uint96[2] memory assets,
        uint256 lastUpdatedTime
    ) external view override returns (uint96[2] memory) {}

    function distributeLoss(
        uint256 loss,
        uint96[2] memory assets,
        uint256 lastUpdatedTime
    ) external view returns (uint96[2] memory) {}
}
