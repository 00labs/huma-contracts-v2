// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IPoolSafe} from "./interfaces/IPoolSafe.sol";

contract ProfitEscrowStorage {
    struct UserInfo {
        // TODO: should we rename this to `shares`? Although shares = amount in this contract, using
        // two different names makes it appear as though we are mixing two different concepts.
        uint96 amount;
        // `rewardDebt` acts as an accounting mechanism to adjust the claimable rewards for each user,
        // ensuring users can only claim profits generated while their principal was actively contributing to the pool.
        // See comments in the implementation contract for explanations of how this variable changes in value.
        int96 rewardDebt;
    }

    struct EscrowInfo {
        uint96 totalShares;
        // TODO: should we rename this to accProfitPerShare to be consistent with the contract name?
        // `accRewardPerShare` keeps track of the accumulated rewards per share of the pool, where a share is
        // a unit of principal contributed by a user. It's updated whenever profits are added to the pool
        // and is used to calculate the claimable rewards for each user.
        uint96 accRewardPerShare;
    }

    uint256 public totalRewards;
    // TODO: should we call this `controller` instead?
    address public caller;

    IPoolSafe public poolSafe;
    EscrowInfo internal _escrowInfo;

    mapping(address => UserInfo) public userInfo;
}
