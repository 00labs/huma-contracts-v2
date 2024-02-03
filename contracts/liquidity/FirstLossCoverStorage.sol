// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

contract FirstLossCoverStorage {
    IPool public pool;
    IPoolSafe public poolSafe;
    IERC20 public underlyingToken;
    address public poolFeeManager;

    uint8 internal _decimals;
    /// The cumulative amount of loss covered.
    uint256 public coveredLoss;

    EnumerableSet.AddressSet internal _coverProviders;

    uint256[100] private __gap;
}
