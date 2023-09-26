// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IPoolSafe} from "./interfaces/IPoolSafe.sol";

contract ProfitEscrowStorage {
    struct UserInfo {
        uint96 amount;
        int96 rewardDebt;
    }

    struct EscrowInfo {
        uint96 totalShares;
        uint96 accRewardPerShare;
    }

    uint256 public totalRewards;
    address public caller;

    IPoolSafe public poolSafe;
    EscrowInfo internal _escrowInfo;

    mapping(address => UserInfo) public userInfo;
}
