// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

interface ITrancheLogic {
    function distributeProfit(
        uint256 profit,
        uint256 lastUpdatedTime,
        uint96[] memory assets
    ) external view returns (uint96[] memory);

    function distributeLoss(
        uint256 loss,
        uint256 lastUpdatedTime,
        uint96[] memory assets
    ) external view returns (uint96[] memory);
}
