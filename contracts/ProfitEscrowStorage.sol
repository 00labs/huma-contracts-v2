// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IPoolSafe} from "./interfaces/IPoolSafe.sol";

contract ProfitEscrowStorage {
    struct UserInfo {
        uint96 amount;
        // `profitDebt` acts as an accounting mechanism to adjust the claimable profit for each user,
        // ensuring users can only claim profits generated while their principal was actively contributing to the pool.
        // See comments in the implementation contract for explanations of how this variable changes in value.
        int96 profitDebt;
    }

    struct EscrowInfo {
        uint96 totalAmount;
        // `accProfitPerShare` keeps track of the accumulated profit per share of the pool, where a share is
        // a unit of principal contributed by a user. It's updated whenever profits are added to the pool
        // and is used to calculate the claimable profit for each user.
        uint96 accProfitPerShare;
    }

    // The naive implementation of `ProfitEscrow` would require us to iterate over all users and compute the
    // amount of claimable profit for each user in a loop. The use of `profitDebt` and `accProfitPerShare`
    // results in significant reduction in gas cost, making the contract much more scalable.

    address public controller;

    IPoolSafe public poolSafe;
    EscrowInfo internal _escrowInfo;

    mapping(address => UserInfo) public userInfo;
}
