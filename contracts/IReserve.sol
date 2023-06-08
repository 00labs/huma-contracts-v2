// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

interface IReserve {
    function deposit(address from, uint256 amount) external;

    function withdraw(address to, uint256 amount) external;

    function totalAssets() external returns (uint256);
}
