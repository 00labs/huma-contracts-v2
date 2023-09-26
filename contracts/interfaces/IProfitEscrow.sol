// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

interface IProfitEscrow {
    function addProfit(uint256 profit) external;

    function deposit(address account, uint256 amount) external;

    function withdraw(address account, uint256 amount) external;

    function claim(uint256 amount) external;

    function claimable(address account) external view returns (uint256);
}
