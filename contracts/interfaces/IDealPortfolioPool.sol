// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {DealConfig} from "../DealStructs.sol";

interface IDealPortfolioPool {
    function createDealConfig(bytes32 dealHash, DealConfig memory dealConfig) external;

    function borrowFromDeal(bytes32 dealHash, uint256 amount) external;

    function payToDeal(bytes32 dealHash, uint256 amount) external;

    function trancheTotalAssets(uint256 index) external view returns (uint256);

    function updatePool() external returns (uint96[] memory);
}
