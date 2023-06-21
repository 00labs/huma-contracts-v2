// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

interface ICredit {
    function updateProfit() external returns (uint256 profit);

    function calculateProfit() external view returns (uint256 profit);
}
